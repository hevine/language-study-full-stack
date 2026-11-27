/**
 * 单飞：同一个 key 的并发调用只真正执行一次，其余调用复用同一个 Promise。
 *
 * 为什么需要它：今日材料 / 写口命题都是「先查缓存、没有就调模型」的两段式，
 * 而浏览器会并发打同一个接口 —— React StrictMode 在开发模式下把 effect 跑两遍、
 * 用户连点两下、开两个标签页都算。两段式在这时同时读到「缓存为空」，
 * 于是同一天同一份材料被生成两遍：token 花两份，后写入的把先写入的覆盖掉
 * （day_contents 有 UNIQUE(day_id, kind)，不会留重复行，所以从库里看不出异常）。
 *
 * 约定：
 * - key 必须带上「语种 + 目标」这类语义维度（如 `${planId}:${date}:${language}`），
 *   否则切语种后两个语种的请求会被误合并成一次；
 * - 执行结束（成功或失败）立刻释放，失败不会把错误缓存给后续请求；
 * - 仅进程内有效。多实例部署时它只能减少单实例内的重复，跨实例需要数据库级锁。
 */
const inFlight = new Map<string, Promise<unknown>>();

export interface SingleFlightStats {
  /** 真正执行了多少次 */
  started: number;
  /** 有多少次调用被合并到正在执行的那次上 */
  joined: number;
}

const stats: SingleFlightStats = { started: 0, joined: 0 };

export function runOnce<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(key);
  if (existing) {
    stats.joined += 1;
    return existing as Promise<T>;
  }

  stats.started += 1;
  const task = (async () => fn())().finally(() => {
    inFlight.delete(key);
  });

  inFlight.set(key, task);
  return task;
}

/** 仅供自检脚本 / 调试使用 */
export function singleFlightStats(): SingleFlightStats {
  return { ...stats };
}

export function resetSingleFlightStats(): void {
  stats.started = 0;
  stats.joined = 0;
}

export function inFlightCount(): number {
  return inFlight.size;
}
