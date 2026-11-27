/**
 * Standalone TaskPort：无任务系统，所有挂载返回 false。
 *
 * 独立端没有学习计划/每日任务体系，Agent 产物只进 Loop 闭环，不挂任务。
 */
import type { TaskPort } from '../ports';

export function createStubTaskPort(): TaskPort {
  return {
    async attachArtifact() {
      return { attached: false, reason: 'standalone 模式无任务系统，产物仅写入 Loop 闭环' };
    },
  };
}
