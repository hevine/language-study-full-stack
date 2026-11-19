import { addDays } from '../lib/date';

/**
 * 考试报考日历：根据官网发布的报名规律（教育部教育考试院 NEEA / JLPT 官方）
 * 和往年固定节奏，从考试日期倒推出报名、选考场、缴费、打印准考证等关键节点。
 * 数据口径：2025–2026 年官方公告与历年节奏，实际以当年官网通知为准。
 */

export interface ExamEvent {
  id: string;
  /** 距考试日的天数，负数为考前 */
  offsetDays: number;
  date: string;
  title: string;
  /** 节点定位：报名 / 考场 / 证件 / 考试 / 出分 */
  tag: string;
  what: string;
  tips: string[];
  url: string | null;
  /** 是否会生成「报考事务」任务 */
  isTask: boolean;
  taskMinutes: number;
}

export interface ExamFee {
  item: string;
  amount: string;
  note: string;
}

export interface ExamLink {
  label: string;
  url: string;
  note: string;
}

export interface ExamCalendar {
  examId: string;
  examName: string;
  examDate: string;
  /** 考试时间规律说明（官网发布节奏） */
  scheduleNote: string;
  events: ExamEvent[];
  fees: ExamFee[];
  feesNote: string;
  links: ExamLink[];
}

const TOEFL_LINKS: ExamLink[] = [
  {
    label: '托福报名官网（教育部教育考试院）',
    url: 'https://toefl.neea.edu.cn',
    note: '主站；备用站 toefl.neea.cn。注册 NEEA 账号 → 充值 → 选考点与日期 → 缴费。',
  },
  {
    label: 'ETS 托福官网',
    url: 'https://www.ets.org/toefl',
    note: '考试介绍、样题与官方备考资料（报名在大陆走 NEEA，不走 ETS 官网）。',
  },
];

const JLPT_LINKS: ExamLink[] = [
  {
    label: 'JLPT 报名官网（教育部教育考试院）',
    url: 'https://jlpt.neea.edu.cn',
    note: '主站；备用站 jlpt.neea.cn。每次报名都需重新注册个人信息，往年账号不保留。',
  },
  {
    label: 'JLPT 日本官方国际版',
    url: 'https://www.jlpt.jp',
    note: '考试题型、样题、各级别对照表（大陆考生报名走上面的 NEEA 站点）。',
  },
];

const TOPIK_LINKS: ExamLink[] = [
  {
    label: 'TOPIK 报名官网（教育部教育考试院）',
    url: 'https://topik.neea.edu.cn',
    note: '主站；备用站 topik.neea.cn。每年需重新注册个人信息并上传证件照，照片将印在准考证上。',
  },
  {
    label: 'TOPIK 韩国官方',
    url: 'https://www.topik.go.kr',
    note: '考试介绍、样题（기출문제）与各级别评价标准；大陆报名走上面的 NEEA 站点。',
  },
];

const TOPIK_FEES: ExamFee[] = [
  { item: '报名费 TOPIK Ⅰ', amount: '¥300', note: 'TOPIK I（1–2 级）只考听力 + 阅读' },
  { item: '报名费 TOPIK Ⅱ', amount: '¥400', note: 'TOPIK II（3–6 级）考听力 + 写作 + 阅读；费用以当年 NEEA 公告为准' },
  { item: '更改信息', amount: '报名截止前免费', note: '报名截止（缴费通道关闭）后不可退费、不可改级别与考点' },
  { item: '成绩单寄送', amount: '免费 1 份', note: '成绩公布后约 1–2 个月寄到考点，由考生自取或邮寄（以考点通知为准）' },
];

const TOEFL_FEES: ExamFee[] = [
  { item: '考试费', amount: '¥2100', note: '含 4 份免费成绩单寄送（免费送分须在考前一天 22:00 前选定院校）' },
  { item: '逾期报名附加费', amount: '+¥310', note: '考前 7 天内报名加收；考前 2 天彻底关闭报名' },
  { item: '转考费', amount: '¥620', note: '改期或换考点都算转考，考前 4 天（不含考试日）截止' },
  { item: '退考退款', amount: '退 50%', note: '考前 4 天前申请退一半（¥1050），逾期不退，退款留在 NEEA 账户' },
  { item: '成绩增送', amount: '¥146/份', note: '超出 4 份免费额度后每份加收' },
  { item: '口语复议 / 写作复议', amount: '¥615 / ¥615', note: '双项一起复议 ¥1229；考后 30 天内申请，已送分的成绩不能复议' },
  { item: '恢复已取消成绩', amount: '¥154', note: '考后 60 天内可申请' },
];

const JLPT_FEES: ExamFee[] = [
  { item: '报名费 N1 / N2', amount: '¥550', note: '2026 年 12 月考试官方标准，最终以当年公告为准' },
  { item: '报名费 N3 / N4 / N5', amount: '¥450', note: '同上；每人每次只能报一个级别，不可同时报多个' },
  { item: '更改考点', amount: '免费 1 次', note: '仅限缴费成功后、报名截止前；不可更改级别，报名费不退' },
];

/**
 * 托福 iBT（中国大陆）：几乎每周末都有考位，全年考位在前一年 11 月下旬统一开放。
 * 关键节奏：常规报名截止考前 7 天 → 逾期报名（+¥310）截止考前 2 天 →
 * 转考/退考截止考前 4 天 → 考前 4–5 天可打印准考证 → 考后约 72 小时出分。
 */
function toeflCalendar(examDate: string): ExamCalendar {
  const event = (
    id: string,
    offsetDays: number,
    title: string,
    tag: string,
    what: string,
    tips: string[],
    isTask: boolean,
    taskMinutes = 15,
  ): ExamEvent => ({
    id,
    offsetDays,
    date: addDays(examDate, offsetDays),
    title,
    tag,
    what,
    tips,
    url: isTask || offsetDays > -80 ? TOEFL_LINKS[0].url : null,
    isTask,
    taskMinutes,
  });

  return {
    examId: 'toefl',
    examName: '托福 iBT',
    examDate,
    scheduleNote:
      'ETS 与教育部教育考试院（NEEA）全年安排多场考试，几乎每个周末都有考位；全年考位一般在前一年 11 月下旬统一开放报名。热门城市（北上广深）建议提前 2–3 个月锁定考位；每周三、周五上午 10 点会释放退考/转考的余位，没抢到可以蹲守。',
    events: [
      event(
        'reserve',
        -75,
        '锁定考位',
        '报名',
        '登录 NEEA 报名系统查考位，选定城市与考试日期并尽快缴费占位。',
        [
          '提前在账户里充值 ¥2100，避免抢到考位却因缴费超时被释放',
          '每周三、五上午 10 点释放转考/退考余位，可以蹲守捡漏',
          '先倒推最晚可接受考试日，给自己留一次重考的余量',
        ],
        true,
        20,
      ),
      event(
        'register-deadline',
        -7,
        '常规报名截止',
        '报名',
        '此后报名要加 ¥310 逾期附加费，考前 2 天彻底关闭报名。',
        ['报名信息（姓名拼音、证件号、出生日期）必须与身份证完全一致，否则拒绝入场且不退费'],
        false,
      ),
      event(
        'transfer-deadline',
        -4,
        '转考 / 退考截止',
        '考场',
        '改期、换考点或退考都要在考前 4 天前操作，逾期无法办理。',
        ['退考只退 50% 报名费；转考 ¥620 且需要目标考位有空位'],
        false,
      ),
      event(
        'ticket',
        -5,
        '打印准考证',
        '证件',
        '登录 NEEA 报名系统下载打印准考证（ETS 注册号生成可能延迟 1–3 天）。',
        [
          '建议打印 2 份纸质版备用',
          '同时核对考试地点、入场时间（上午场 08:30 签到 / 09:00 截止入场）',
        ],
        true,
        10,
      ),
      event(
        'precheck',
        -1,
        '考前最后检查',
        '证件',
        '核对证件与免费送分院校，规划赴考路线。',
        [
          '必须携带有效期内的二代身份证原件，且有效期需超过考试日 1 个月（复印件、电子证、临时身份证无效）',
          '免费送分院校须在考前一天 22:00 前选定，共 4 个免费名额',
          '考场提供草稿纸与铅笔；手机、智能手表、复习资料严禁带入',
        ],
        true,
        15,
      ),
      event('exam', 0, '考试日', '考试', '托福 iBT 正式考试。', ['提前 30 分钟到考场，带齐身份证原件与准考证'], false),
      event(
        'score',
        4,
        '查询成绩',
        '出分',
        '线下考试结束后约 72 小时（3–6 个工作日）可在官网查询电子成绩。',
        ['对口语/写作有异议可考后 30 天内申请复议（¥615/项）', '10–12 月申请高峰出分偶尔延迟 1–2 天'],
        false,
      ),
    ],
    fees: TOEFL_FEES,
    feesNote: '费用为 2026 年中国大陆 NEEA 报名系统标准，支付支持支付宝、中银智慧付、招行一网通；以报名系统实时公示为准。',
    links: TOEFL_LINKS,
  };
}

/**
 * 日本语能力测试 JLPT（中国大陆）：每年仅两次——7 月第一个周日、12 月第一个周日。
 * 报名节奏（以 2026 年 12 月 6 日考试为例）：8 月 28 日注册个人信息 →
 * 9 月 1 日起报名选考点并 24 小时内缴费 → 9 月 8 日 14:00 报名截止 →
 * 11 月 30 日 14:00 起打印准考证 → 考后约 2 个月出分。
 */
function jlptCalendar(examDate: string): ExamCalendar {
  const event = (
    id: string,
    offsetDays: number,
    title: string,
    tag: string,
    what: string,
    tips: string[],
    isTask: boolean,
    taskMinutes = 15,
  ): ExamEvent => ({
    id,
    offsetDays,
    date: addDays(examDate, offsetDays),
    title,
    tag,
    what,
    tips,
    url: isTask || offsetDays > -80 ? JLPT_LINKS[0].url : null,
    isTask,
    taskMinutes,
  });

  return {
    examId: 'jlpt',
    examName: '日本语能力测试（JLPT）',
    examDate,
    scheduleNote:
      'JLPT 每年只有两次：7 月第一个周日、12 月第一个周日，错过一次就要再等半年。报名窗口只有约一周（12 月考试约为 8 月底注册、9 月上旬报名缴费；7 月考试约为 3 月），热门城市考点常在开报后两三天内满员，务必在报名开始当天就完成选考点和缴费。',
    events: [
      event(
        'register-info',
        -100,
        '注册个人信息 + 上传照片',
        '报名',
        '报名开放前先注册个人信息并完成身份核验，上传证件照（将印在准考证上）。',
        [
          '每次报名都需重新注册，往年信息不保留',
          '提前把照片准备好：近期免冠、真实相貌，避免入场核验出问题',
          '注册时间通常比报名早 3–5 天（如 12 月考试 8/28 开注册、9/1 开报名）',
        ],
        true,
        20,
      ),
      event(
        'register-pay',
        -95,
        '报名选考点 + 缴费',
        '报名',
        '报名开放当天登录系统选级别和考点，并在 24 小时内完成缴费。',
        [
          '考位紧张，开报当天上午 7:00 就上手；每天上午 7 点会释放退考的考位',
          'N1/N2 上午考、N3–N5 下午考；只能报一个级别',
          '缴费成功后不可退费、不可改级别，考点只能再变更一次',
        ],
        true,
        20,
      ),
      event(
        'register-deadline',
        -89,
        '报名截止',
        '报名',
        '报名与缴费通道关闭（如 12 月考试为 9 月 8 日 14:00）。',
        ['未缴费前可修改或取消报名；一旦缴费成功就无法退费'],
        false,
      ),
      event(
        'ticket',
        -6,
        '打印准考证',
        '证件',
        '准考证打印开放（如 12 月考试为 11/30 14:00 至考试日 18:00）。',
        [
          '用 A4 纸自行打印，建议 2 份',
          '同时查看考点的入校/入场要求（各考点自行制定，官网「考点信息」页可查）',
        ],
        true,
        10,
      ),
      event(
        'precheck',
        -1,
        '考前物品检查',
        '证件',
        '按考点要求备齐考试用品，规划赴考路线。',
        [
          '必带：与报名一致的有效身份证原件、纸质准考证、2B 或 HB 铅笔、橡皮',
          '入场截止：N1/N2 为 8:40，N3–N5 为 14:10；听力公放，无需耳机',
          '手机等无线设备严禁带入；部分考场不允许中途去卫生间',
        ],
        true,
        15,
      ),
      event(
        'exam',
        0,
        '考试日',
        '考试',
        'JLPT 正式考试（N1 9:15 开考 / N3 15:00 开考，以准考证为准）。',
        ['N1 175 分钟、N2 165 分钟、N3 155 分钟，均含听力，注意耐力分配'],
        false,
      ),
      event(
        'score',
        60,
        '查询成绩',
        '出分',
        '考后约 2 个月可在报名网站查分；证书（成绩单）约 3 个月寄到考点，保存两年。',
        ['总分量点化 180 分制：N1 合格 100 分且单项 ≥19，N2 合格 90 分且单项 ≥19'],
        false,
      ),
    ],
    fees: JLPT_FEES,
    feesNote: '费用为大陆官网统一标准（N1/N2 ¥550、N3–N5 ¥450），支持微信/支付宝；最终以当年官方公告为准。',
    links: JLPT_LINKS,
  };
}

/**
 * TOPIK（中国大陆）：每年仅两次纸笔考试——4 月中旬与 10 月中旬的周日。
 * 报名节奏（以 2026 年 10 月 18 日考试为例）：7 月 14 日 14:00 起注册个人信息 →
 * 7 月 16 日 14:00 起报名选考点并缴费 → 7 月 23 日 14:00 报名截止 →
 * 10 月 12 日 14:00 起打印准考证 → 考后约 45–50 天出分（12 月上旬）。
 */
function topikCalendar(examDate: string): ExamCalendar {
  const event = (
    id: string,
    offsetDays: number,
    title: string,
    tag: string,
    what: string,
    tips: string[],
    isTask: boolean,
    taskMinutes = 15,
  ): ExamEvent => ({
    id,
    offsetDays,
    date: addDays(examDate, offsetDays),
    title,
    tag,
    what,
    tips,
    url: isTask || offsetDays > -80 ? TOPIK_LINKS[0].url : null,
    isTask,
    taskMinutes,
  });

  return {
    examId: 'topik',
    examName: 'TOPIK 韩国语能力考试',
    examDate,
    scheduleNote:
      'TOPIK 大陆纸笔考每年只有两次：4 月中旬与 10 月中旬的周日（TOPIK I 上午 9:10 开考、TOPIK II 下午 13:00 开考），错过一次就要再等半年。报名窗口约一周：考前 3 个月左右先开放个人信息注册，两三天后开放报名与缴费，热门城市考位按先到先得放完即止。若等不及可以关注 TOPIK IBT 机考（大陆暂未开考，中国香港等海外考区有场次）。',
    events: [
      event(
        'register-info',
        -96,
        '注册个人信息 + 上传照片',
        '报名',
        '报名开放前先注册个人信息，上传证件照（将印在准考证上并用于入场核验）。',
        [
          '每年报名都要重新填写并核验个人信息，往年资料不保留',
          '照片要求免冠、真实相貌；照片与本人差异过大可能无法入场',
          '注册时间通常比报名早 2–3 天（如 10 月考试 7/14 开注册、7/16 开报名）',
        ],
        true,
        20,
      ),
      event(
        'register-pay',
        -94,
        '报名选级别考点 + 缴费',
        '报名',
        '报名开放当天登录系统选择 TOPIK I / II 与考点，并在窗口期内完成缴费。',
        [
          '考位先到先得，热门城市开报当天就可能满员',
          'TOPIK I 上午考（1–2 级）、TOPIK II 下午考（3–6 级），同一场只能二选一',
          '缴费成功后不可退费、不可改级别',
        ],
        true,
        20,
      ),
      event(
        'register-deadline',
        -87,
        '报名截止',
        '报名',
        '注册与报名缴费通道关闭（如 10 月考试为 7/23 14:00）。',
        ['一旦截止无法补报；下一场要再等半年，设好日历提醒'],
        false,
      ),
      event(
        'ticket',
        -6,
        '打印准考证',
        '证件',
        '准考证打印开放（如 10 月考试为 10/12 14:00 至考试日 17:00）。',
        [
          '自行打印，建议 2 份备用',
          '核对考点地址与入校要求（各考点自行制定，报名网站「考点信息」可查）',
        ],
        true,
        10,
      ),
      event(
        'precheck',
        -1,
        '考前物品检查',
        '证件',
        '备齐证件与考试用品，规划赴考路线。',
        [
          '必带：与报名一致的有效身份证原件、纸质准考证',
          'TOPIK I 入场截止 8:50（9:10 开考）、TOPIK II 入场截止 12:40（13:00 开考），下午场注意午休安排',
          '听力公放；只许带文具，修正带与电子设备严禁使用',
        ],
        true,
        15,
      ),
      event(
        'exam',
        0,
        '考试日',
        '考试',
        'TOPIK 正式考试（TOPIK I 9:10–10:50 / TOPIK II 13:00–16:10）。',
        ['TOPIK II 三科连考约 3 小时，注意体力分配；答题卡为 OMR 涂卡'],
        false,
      ),
      event(
        'score',
        50,
        '查询成绩',
        '出分',
        '考后约 45–50 天在报名网站查分（如 10 月考试约 12 月上旬出分）。',
        ['成绩单约出分后 1–2 个月寄到考点；等级按总分划定，无单项合格线'],
        false,
      ),
    ],
    fees: TOPIK_FEES,
    feesNote: '费用为大陆报名网站近年标准（TOPIK Ⅰ ¥300 / TOPIK Ⅱ ¥400），支持支付宝；最终以当年官方公告为准。',
    links: TOPIK_LINKS,
  };
}

export function buildExamCalendar(examId: string, examDate: string): ExamCalendar | null {
  if (examId === 'toefl') return toeflCalendar(examDate);
  if (examId === 'jlpt') return jlptCalendar(examDate);
  if (examId === 'topik') return topikCalendar(examDate);
  return null;
}

/** 官方报名 / 资讯入口（不依赖具体考试日期，供设置页与计划页直接展示） */
export function examLinks(examId: string): ExamLink[] {
  if (examId === 'toefl') return TOEFL_LINKS;
  if (examId === 'jlpt') return JLPT_LINKS;
  if (examId === 'topik') return TOPIK_LINKS;
  return [];
}

/** 按 id 找节点 */
export function findExamEvent(calendar: ExamCalendar, eventId: string): ExamEvent | undefined {
  return calendar.events.find((event) => event.id === eventId);
}
