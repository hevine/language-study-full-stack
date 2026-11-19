/**
 * 演示模式（未配置大模型）下的题目库。
 * 每题自带情境、任务与构思提示，按天轮换；配置模型后会按当日主题与考纲实时命题。
 */

export interface PromptTemplate {
  title: string;
  /** 题干情境（考试语言） */
  scenario: string;
  /** 托福学术讨论：两位同学观点 */
  stimulus?: { a: string; b: string };
  /** 具体写作/作答任务（考试语言） */
  question: string;
  /** 中文构思提示 */
  hints: string[];
  /** 提交前自检清单（中文） */
  checklist: string[];
}

const EN_CHECKLIST = [
  '是否在开头两句内明确表态？',
  '每个理由后面是否跟了具体例证（人/事/数据）？',
  '有没有重复使用同一个连接词？',
  '通读一遍，检查主谓一致、时态与冠词。',
];

const EN_SPEAK_CHECKLIST = [
  '是否先给结论，再补理由？',
  '有没有用一个具体经历支撑观点？',
  '是否在 45 秒内收束，而不是被截断？',
  '回听录音，标记出所有 um / uh 的位置。',
];

const TOEFL_WRITING: PromptTemplate[] = [
  {
    title: '学术讨论：大学是否应要求所有学生修一门编程课',
    scenario:
      'Your professor is teaching a course on higher education policy. In this week’s discussion, the class is debating whether every undergraduate should be required to take at least one programming course before graduation.',
    stimulus: {
      a: 'Lin: Programming is now basic literacy. Even a history major will spend hours each week cleaning spreadsheets, so one course saves everyone time later.',
      b: 'Daniel: Requiring a coding course takes a slot away from a subject a student actually cares about. We should teach computational thinking inside existing courses instead.',
    },
    question:
      'Write a post of at least 100 words responding to the discussion. State your own view clearly and explain why, referring to one or both of the students’ opinions.',
    hints: [
      '先选边：支持必修、反对必修，或折中（必修但改成通识向的数据课）。',
      '准备一个具体场景：你在实习/社团里因为不会处理数据而卡住的经历，比抽象说理更有说服力。',
      '回应其中一位同学的观点，用一句话承认其合理处再反驳，逻辑更完整。',
    ],
    checklist: EN_CHECKLIST,
  },
  {
    title: '学术讨论：城市是否应限制私家车进入市中心',
    scenario:
      'In a sociology seminar on urban life, the class is discussing whether city centers should ban private cars during daytime hours.',
    stimulus: {
      a: 'Marta: A ban cuts congestion and pollution immediately, and the revenue from congestion pricing can fund buses, which benefits people who cannot afford cars.',
      b: 'Owen: Small businesses depend on customers who drive in. A ban punishes people who live far from transit before the transit system is actually good enough.',
    },
    question:
      'Write a post of at least 100 words. Explain your position and support it with specific reasons or an example. Engage with at least one classmate’s point.',
    hints: [
      '关键分歧点是「先修公交还是先限车」，可以围绕顺序做文章。',
      '举一个你熟悉的小城市/街道的例子，说明限行后的连锁反应。',
      '避免两边都对的空话，最后要落到一个可执行的方案。',
    ],
    checklist: EN_CHECKLIST,
  },
  {
    title: '学术讨论：大学是否应禁止在课堂上使用笔记本电脑',
    scenario:
      'The class is discussing a proposal to ban laptops in lecture halls, following a study showing that handwritten notes lead to better recall of concepts.',
    stimulus: {
      a: 'Priya: Banning laptops removes distraction for everyone. Even students who take notes by hand get pulled off task by the screens around them.',
      b: 'Sam: The problem is not the device but the lecture. If slides are posted online, nobody needs to transcribe them, and laptops become useful for looking up sources in real time.',
    },
    question:
      'Write a post of at least 100 words. State your view and explain your reasoning with a concrete example from your own classes.',
    hints: [
      '可以区分「记概念」和「查资料」两种课堂，按课程类型给条件式结论。',
      '引用一次自己上课被屏幕干扰或被工具帮助的经历。',
      '把「禁与不禁」的争论转成「怎么管」的方案，容易写出深度。',
    ],
    checklist: EN_CHECKLIST,
  },
];

const IELTS_WRITING: PromptTemplate[] = [
  {
    title: 'Task 2：远程办公是否让员工更自由',
    scenario:
      'Some people believe that working from home gives employees more control over their lives. Others argue that it blurs the boundary between work and rest and therefore reduces freedom.',
    question:
      'Discuss both views and give your own opinion. Write at least 250 words.',
    hints: [
      '双方各写一个主体段：自由（省通勤、可安排家庭）vs 不自由（随时在线、工时变长）。',
      '自己的立场放在引言最后一句，并在结论重申，不要中途换边。',
      '每个主体段配一个具体职业例子：教师、程序员、客服的处境差别很大。',
    ],
    checklist: [
      '是否覆盖了题目里的两个观点（discuss both views）？',
      '自己的立场是否从头到尾一致？',
      '每个主体段是否只有一个中心论点？',
      '是否检查了复杂句中的主谓一致与从句连接？',
    ],
  },
  {
    title: 'Task 2：博物馆是否应该免费开放',
    scenario:
      'Many museums now charge an entrance fee, while others remain free and rely on public funding. Both models claim to serve the public interest.',
    question:
      'What are the advantages and disadvantages of charging for museum entry? Do you think museums should be free? Give reasons for your answer and include any relevant examples. Write at least 250 words.',
    hints: [
      '收费的好处：稳定收入、控制人流、保护展品；坏处：把低收入群体挡在门外。',
      '可以提出分层方案：基础展免费、特展收费。',
      '例证可以是故宫、大英博物馆或你所在城市的博物馆。',
    ],
    checklist: [
      '是否既写了 advantages 又写了 disadvantages？',
      '是否明确回答了「should museums be free」？',
      '段落之间是否有清晰的过渡句？',
      '是否避免了 "more and more people" 这类空泛表达？',
    ],
  },
  {
    title: 'Task 2：大学生是否应该先工作再上大学',
    scenario:
      'In some countries, students take a gap year or work for a few years before entering university. In others, students go directly from school to university.',
    question:
      'Do the advantages of taking a gap year before university outweigh the disadvantages? Give reasons for your answer and include examples from your own knowledge or experience. Write at least 250 words.',
    hints: [
      '好处：明确专业方向、攒学费、成熟度更高；坏处：学习状态中断、同龄人压力、规划不当会空耗一年。',
      '给出条件式结论：有明确计划的一年有价值，「为了逃避」的一年没有。',
      '用一个人的具体经历贯穿全文，比列举三点更有说服力。',
    ],
    checklist: [
      '是否直接回答了 "do the advantages outweigh the disadvantages"？',
      '是否有至少两个展开充分的理由（而非四个一笔带过的理由）？',
      '是否用了多样的衔接手段而不是 First/Second/Finally 三连？',
      '结尾是否只总结、不引入新观点？',
    ],
  },
];

const CET6_WRITING: PromptTemplate[] = [
  {
    title: 'On the Value of Failure',
    scenario:
      'Directions: For this part, you are allowed 30 minutes to write an essay on the value of failure. You should write at least 150 words but no more than 200 words.',
    question:
      'Write an essay explaining why failure can be valuable and how students can learn from it. Use specific examples to support your view.',
    hints: [
      '开头两句内给观点：失败的价值在于提供真实反馈。',
      '主体段用一个具体失败经历（比赛/考试/项目），写清「错在哪—改了什么—结果如何」。',
      '结尾落到方法：复盘三问（期望、实际、差距原因）。',
    ],
    checklist: ['观点句是否在开头两句内？', '例子是否具体到事件与结果？', '是否避免 "With the development of society" 这类模板句？', '字数是否在 150–200 之间？'],
  },
  {
    title: 'Should College Students Take Part-time Jobs?',
    scenario:
      'Directions: You are allowed 30 minutes to write an essay on whether college students should take part-time jobs. You should write at least 150 words but no more than 200 words.',
    question:
      'State your opinion on part-time jobs for college students and support it with reasons and examples.',
    hints: [
      '可以持「有条件支持」：与专业相关、每周不超过 10 小时。',
      '反面情况要写：纯体力兼职挤占学习时间、影响绩点。',
      '用「时间成本」这一条贯穿，比罗列优缺点更有条理。',
    ],
    checklist: ['是否有一个统摄全文的关键概念？', '正反两面是否都提到并给出判断？', '三段之间是否有过渡？', '是否检查了第三人称单数的动词形式？'],
  },
  {
    title: 'The Impact of Short Videos on Reading Habits',
    scenario:
      'Directions: You are allowed 30 minutes to write an essay on how short videos affect the reading habits of young people. You should write at least 150 words but no more than 200 words.',
    question:
      'Analyse the impact of short videos on young people’s reading habits and suggest how they can keep deep reading alive.',
    hints: [
      '现象：注意力被切成 15 秒单位，长文本耐受度下降。',
      '分析要给出机制，而不只是「不好」：即时奖励 vs 延迟奖励。',
      '建议要具体：每天固定 20 分钟无手机阅读、读完写三句话摘要。',
    ],
    checklist: ['是否先描述现象再分析原因？', '建议是否具体可执行？', '是否用了一个准确的数据或研究（不必精确到年份）？', '是否有中式英语的直译？'],
  },
];

const KAOYAN_WRITING: PromptTemplate[] = [
  {
    title: '图画作文：两代人的手机',
    scenario:
      '图画描述：一张餐桌上，祖孙三代围坐，年轻人各自低头看手机，老人独自举筷，桌上菜已凉。图下文字：「世界上最远的距离」。',
    question:
      'Write an essay of 160–200 words. In the first paragraph describe the picture, in the second interpret its meaning, and in the third give your comments.',
    hints: [
      '第一段只描述：人物、动作、细节（凉掉的菜、「世界上最远的距离」），不要评论。',
      '第二段点出寓意：技术连接了远方，却疏远了身边人；可提「在场却缺席」。',
      '第三段给建议：设「无手机时段」、把手机叠放桌上，具体到可执行。',
    ],
    checklist: ['三段是否各司其职（描述/寓意/评论）？', '第一段有没有提前议论？', '寓意是否与画面细节对应？', '是否有主谓一致或时态错误？'],
  },
  {
    title: '图画作文：考研教室的灯光',
    scenario:
      '图画描述：深夜的自习室，一名学生趴在桌上睡着，面前堆着复习资料，窗外天将亮；墙上标语写着「再坚持一下」。',
    question:
      'Write an essay of 160–200 words. Describe the picture, explain what it suggests about persistence and burnout, and give your comments.',
    hints: [
      '寓意可从「努力值得尊敬，但方法比时长更重要」切入。',
      '避免写成鸡汤，要指出低效熬夜的代价。',
      '评论段落给一个具体方法：番茄工作法 + 每天固定复盘 10 分钟。',
    ],
    checklist: ['是否描述了两个以上细节？', '寓意是否超出「努力就会成功」的层面？', '评论是否具体而非口号？', '句式是否有变化？'],
  },
  {
    title: '图表作文：城市通勤时间变化',
    scenario:
      '图表描述：某市 2015–2025 年居民平均单程通勤时间由 32 分钟上升至 47 分钟；同期地铁里程由 120 公里增至 480 公里。',
    question:
      'Write an essay of 160–200 words. Describe the chart, explain the possible reasons for the trend, and give your comments.',
    hints: [
      '描述数据要抓对比：通勤时间上升 47%，地铁里程翻两番，二者背离。',
      '原因分析：职住分离、房价外溢、换乘耗时。',
      '评论可提「最后一公里」与错峰上班。',
    ],
    checklist: ['是否引用了具体数字？', '是否解释了「地铁变多但通勤更久」的矛盾？', '是否有段落主题句？', '是否检查了数字表达（increase by / increase to）？'],
  },
];

const EN_SPEAKING: Record<string, PromptTemplate[]> = {
  toefl: [
    {
      title: 'Independent Speaking: a skill you learned outside school',
      scenario:
        'Some students believe the most useful skills are learned in the classroom; others think they are learned outside it.',
      question:
        'Which view do you agree with? Give one specific example from your own experience. You have 15 seconds to prepare and 45 seconds to speak.',
      hints: [
        '第一句给答案：例如「最重要的技能是校外学的」。',
        '例子要有一个完整小故事：起因—过程—结果。',
        '准备 15 秒只写 3 个关键词，不要写整句。',
      ],
      checklist: EN_SPEAK_CHECKLIST,
    },
    {
      title: 'Independent Speaking: studying alone or in a group',
      scenario: 'Some students prefer to study alone; others prefer to study in a group.',
      question:
        'Which do you prefer and why? Include one specific example in your answer. You have 15 seconds to prepare and 45 seconds to speak.',
      hints: [
        '选一个立场即可，不需要两面讨好。',
        '例子写具体：哪门课、几个人、结果如何。',
        '结尾留 3 秒收束，不要说到一半被切断。',
      ],
      checklist: EN_SPEAK_CHECKLIST,
    },
    {
      title: 'Independent Speaking: a place that helps you focus',
      scenario: 'Describe a place where you can concentrate best.',
      question:
        'Describe the place and explain why it helps you focus. Use specific details. You have 15 seconds to prepare and 45 seconds to speak.',
      hints: [
        '地点 + 两个特征（声音、光线、人流）+ 一个具体效果。',
        '对比一个干扰场景，反差更清楚。',
        '用现在时描述，避免时态跳跃。',
      ],
      checklist: EN_SPEAK_CHECKLIST,
    },
  ],
  ielts: [
    {
      title: 'Part 2: Describe a skill you would like to learn',
      scenario: 'You should say: what the skill is, how you would learn it, how long it might take, and why you want to learn it.',
      question: 'Describe a skill you would like to learn. You have 1 minute to prepare and 2 minutes to speak.',
      hints: [
        '题卡四点必须全覆盖，顺序可调整。',
        '用一件具体的事说明动机（看过某人做过、工作上需要）。',
        '补一句「学会之后会怎样」，让结尾自然收束。',
      ],
      checklist: ['四个要点是否都覆盖？', '是否使用了至少三种时态？', '有没有具体细节（时间、地点、人物）？', '是否有长时间卡顿？'],
    },
    {
      title: 'Part 2: Describe a time you changed your mind',
      scenario: 'You should say: what you changed your mind about, what made you change it, who was involved, and how you felt afterwards.',
      question: 'Describe a time when you changed your mind about something important. You have 1 minute to prepare and 2 minutes to speak.',
      hints: [
        '用过去时叙事，观点变化前后各一句。',
        '关键是「什么让你改变」：一次谈话、一个数据、一次失败。',
        '结尾说感受与后来的影响。',
      ],
      checklist: ['叙事时态是否稳定在过去时？', '是否说明了改变的原因？', '是否有情感描述？', '是否用连接词推进而非 "and then and then"？'],
    },
    {
      title: 'Part 2: Describe a useful website or app',
      scenario: 'You should say: what it is, how you found it, how often you use it, and why it is useful to you.',
      question: 'Describe a website or app you find useful. You have 1 minute to prepare and 2 minutes to speak.',
      hints: [
        '选一个你真的每天用的，细节才够。',
        '说清「没用它之前」的麻烦，价值更明显。',
        '避免广告式夸奖，给一个局限。',
      ],
      checklist: ['是否说明了具体使用场景？', '是否有一个局限/不足？', '词汇是否重复过多？', '是否在 2 分钟内结束？'],
    },
  ],
  default: [
    {
      title: 'Speaking: a decision you regret',
      scenario: 'Think about a decision you made that you now regret.',
      question: 'Describe the decision, explain why you made it, and say what you would do differently. You have 30 seconds to prepare and 60 seconds to speak.',
      hints: ['结论先行：一句话说清是什么决定。', '给一个具体后果，不要停在「我很后悔」。', '结尾说清下次会怎么做。'],
      checklist: EN_SPEAK_CHECKLIST,
    },
  ],
};

const JA_WRITING: PromptTemplate[] = [
  {
    title: '記述：スマートフォンは学習の敵か味方か',
    scenario:
      '近年、スマートフォンの使いすぎが学習時間や集中力に影響すると言われている。一方で、調べ学習やオンライン授業など、学習を助ける道具としての側面もある。',
    question:
      'スマートフォンは学習にとってプラスかマイナスか。あなたの立場を明らかにし、理由を具体的に挙げて 200〜250 字で述べなさい。',
    hints: [
      '第一段落で立場を明示（〜と考える）。',
      '第二段落に具体的な経験（どの場面で役立った／妨げになったか）。',
      '第三段落で条件や使い方の提案を書くと字数が埋まり、内容も深まる。',
    ],
    checklist: ['立場が最初の 2 文以内にあるか', '理由が 1 つに絞られているか', '助詞（は／が／を／に）の抜けがないか', '字数は 200 字を超えているか'],
  },
  {
    title: '記述：地方の過疎化をどう食い止めるか',
    scenario:
      '地方の市町村では人口減少と高齢化が進み、学校や公共交通の維持が難しくなっている。移住支援やテレワークの導入など、さまざまな対策が試みられている。',
    question:
      '過疎化を食い止めるために最も有効な対策は何か。一つ選び、その理由を具体的に述べて 200〜250 字で書きなさい。',
    hints: [
      '対策は一つに絞る（雇用、交通、教育、住宅のいずれか）。',
      '「なぜそれが効くのか」を因果で説明する。',
      '最後に短所とその補い方を一言添えると評価が上がる。',
    ],
    checklist: ['対策を一つに絞ったか', '因果関係が接続詞で示されているか', '同じ語尾の繰り返しが多くないか', '敬体／常体が混ざっていないか'],
  },
  {
    title: '記述：AI 時代に必要な能力',
    scenario:
      '生成 AI が文章や画像を短時間で作れるようになり、人が身につけるべき能力も変わると言われている。知識の暗記よりも、問いを立てる力や編集する力が重視されるという指摘もある。',
    question:
      'AI 時代に最も必要な能力は何か。あなたの考えを理由とともに 200〜250 字で述べなさい。',
    hints: [
      '能力は一つに限定する（問いを立てる力／検証する力／対話する力など）。',
      'AI では代替できない理由を明確に。',
      '自分の学習経験と結びつけると具体性が出る。',
    ],
    checklist: ['能力を一つに限定したか', 'AI と人の役割の違いに触れたか', '接続詞（したがって／なぜなら）が適切か', '漢字と仮名のバランスは自然か'],
  },
];

const JA_SPEAKING: PromptTemplate[] = [
  {
    title: 'スピーチ：好きな季節',
    scenario: '季節の中で、あなたが最も好きな季節について話してください。',
    question: '好きな季節を一つ選び、その理由を具体的な経験を交えて 60 秒で話しなさい。',
    hints: ['最初に季節を言い切る。', '理由は二つまで、それぞれ一言の具体例を付ける。', '最後に「だから〜が楽しみだ」で締める。'],
    checklist: ['結論が最初にあるか', '「えーと」が 3 回以内か', '助詞が抜けていないか', '60 秒で終わったか'],
  },
  {
    title: 'スピーチ：日本で行ってみたい場所',
    scenario: '日本で一度行ってみたい場所と、その理由について話してください。',
    question: '行きたい場所を一つ挙げ、理由とそこで何をしたいかを 60 秒で説明しなさい。',
    hints: ['場所は一つに絞る。', '理由は「見たいもの／体験したいこと」で具体化。', '可能表現（〜てみたい）を積極的に使う。'],
    checklist: ['場所が最初に明示されているか', '具体的な行動が述べてあるか', '同じ語尾の連続がないか', '沈黙が長くないか'],
  },
  {
    title: 'スピーチ：仕事と学習の両立',
    scenario: '仕事や学業と、語学学習を両立させるのは難しいと言われています。',
    question: '両立のために大切なことを一つ挙げ、自分の経験を交えて 60 秒で話しなさい。',
    hints: ['方法を一つに絞る（朝の 30 分、通勤中の音読など）。', '続けられた理由と、途切れた経験も正直に話すと説得力が出る。', '最後に具体的な数値目標を添える。'],
    checklist: ['主张が一つに絞られているか', '経験が具体的か', '接続詞が使われているか', '時間内にまとまったか'],
  },
];

const DEFAULT_EN_SPEAKING = EN_SPEAKING.default;

// —— TOPIK 写作 / 口语题库（原创命题，围绕社会话题与议论结构）——
const KO_WRITING: PromptTemplate[] = [
  {
    title: '쓰기: 스마트폰은 학습의 적인가 동반자인가',
    scenario:
      '스마트폰을 너무 오래 쓰면 학습 시간과 집중력이 떨어진다고 한다. 반면에 조사 학습이나 온라인 수업처럼 학습을 돕는 도구로 쓸 수 있다는 주장도 있다.',
    question:
      '스마트폰이 학습에 주는 영향은 긍정적인가, 부정적인가. 자신의 입장을 밝히고 그 이유를 구체적으로 들어 200~300자로 쓰시오.',
    hints: [
      '첫 문장에서 입장을 분명히 밝힌다（~라고 생각한다）.',
      '두 번째 문단에서 구체적인 경험이나 근거를 한 가지 고른다.',
      '마지막에 조건이나 사용 방법을 제안하면 분량과 내용이 모두 채워진다.',
    ],
    checklist: ['입장이 처음 두 문장 안에 있는가', '근거가 하나로 모여 있는가', '조사(은/는/이/가/을/를)가 빠지지 않았는가', '어미가 서술체로 통일되어 있는가'],
  },
  {
    title: '쓰기: 재활용을 늘리는 가장 효과적인 방법',
    scenario:
      '도시마다 쓰레기 분리배출을 하고 있지만 실제 재활용률은 쉽게 올라가지 않는다. 캠페인, 요금제, 편의 시설 등 여러 방법이 시도되고 있다.',
    question:
      '재활용률을 높이는 데 가장 효과적인 방법이 무엇이라고 생각하는가. 하나를 골라 그 이유를 구체적으로 200~300자로 쓰시오.',
    hints: [
      '방법은 하나로 한정한다（캠페인 / 요금 / 시설 중 하나）.',
      '"왜 효과가 있는가"를 인과관계로 설명한다.',
      '마지막에 단점과 보완 방법을 한 문장 덧붙이면 좋다.',
    ],
    checklist: ['방법을 하나로 한정했는가', '인과관계가 연결어미로 드러나는가', '같은 어미의 반복이 많지 않은가', '분량이 200자를 넘는가'],
  },
  {
    title: '쓰기: 인공지능 시대에 필요한 능력',
    scenario:
      '생성형 인공지능이 글과 그림을 짧은 시간에 만들어 내면서, 사람이 갖추어야 할 능력도 달라지고 있다는 말이 나온다.',
    question:
      '인공지능 시대에 가장 필요한 능력이 무엇이라고 생각하는가. 그 이유와 함께 200~300자로 쓰시오.',
    hints: [
      '능력을 하나로 한정한다（질문하는 힘 / 검증하는 힘 / 협업하는 힘 등）.',
      '인공지능이 대신할 수 없는 이유를 분명히 쓴다.',
      '자신의 학습 경험과 연결하면 구체성이 생긴다.',
    ],
    checklist: ['능력을 하나로 한정했는가', '인공지능과 사람의 역할 차이를 다루었는가', '연결어(따라서/그러므로/즉)가 적절한가', '한자어와 고유어의 균형이 자연스러운가'],
  },
];

const KO_SPEAKING: PromptTemplate[] = [
  {
    title: '말하기: 메신저 속 친구는 진짜 친구인가',
    scenario: '모바일 메신저와 SNS 덕분에 친구를 사귀는 방법이 다양해졌다.',
    question: '온라인으로만 만나는 친구도 진짜 친구라고 생각하는가? 자신의 의견을 60초 안에 말하시오.',
    hints: ['첫 문장에 입장을 밝힌다.', '이유 하나에 경험 하나를 붙인다.', '마지막에 한 문장으로 정리한다.'],
    checklist: ['입장이 분명한가', '근거가 구체적인가', '60초 안에 끝났는가'],
  },
  {
    title: '말하기: 워라밸을 위해 회사가 바꾸어야 할 것',
    scenario: '최근 직장인들의 퇴사와 이직이 늘어나면서 일과 삶의 균형이 화제가 되고 있다.',
    question: '직원의 워라밸을 위해 회사가 가장 먼저 바꾸어야 할 것은 무엇인가? 60초 안에 말하시오.',
    hints: ['바꾸어야 할 것을 하나만 고른다.', '"왜 지금 필요한가"를 말한다.', '구체적인 예시를 하나 든다.'],
    checklist: ['주제에 맞게 답했는가', '근거가 명확한가', '발음과 끊어 읽기가 안정적인가'],
  },
  {
    title: '말하기: 대학 전공 선택, 취업을 기준으로 해야 하는가',
    scenario: '학생들이 대학 전공을 고를 때 취업 가능성을 가장 큰 기준으로 두는 경우가 많다.',
    question: '전공을 고를 때 취업을 가장 중요한 기준으로 삼아야 하는가? 자신의 의견을 60초 안에 말하시오.',
    hints: ['찬성 또는 반대 입장을 먼저 말한다.', '이유를 두 가지 이내로 압축한다.', '반대 의견을 한 번 언급하고 반박하면 좋다.'],
    checklist: ['입장이 처음에 나오는가', '근거가 두 개 이하로 정리되었는가', '어미가 해요체로 통일되었는가'],
  },
];

export function pickPrompt(
  examId: string,
  language: 'en' | 'ja' | 'ko',
  kind: 'write' | 'speak',
  seed: number,
): PromptTemplate {
  if (language === 'ja') {
    const pool = kind === 'write' ? JA_WRITING : JA_SPEAKING;
    return pool[Math.abs(seed) % pool.length];
  }

  if (language === 'ko') {
    const pool = kind === 'write' ? KO_WRITING : KO_SPEAKING;
    return pool[Math.abs(seed) % pool.length];
  }

  if (kind === 'write') {
    const pool =
      examId === 'toefl'
        ? TOEFL_WRITING
        : examId === 'ielts'
          ? IELTS_WRITING
          : examId === 'cet6'
            ? CET6_WRITING
            : examId === 'kaoyan'
              ? KAOYAN_WRITING
              : IELTS_WRITING;
    return pool[Math.abs(seed) % pool.length];
  }

  const pool = EN_SPEAKING[examId] ?? DEFAULT_EN_SPEAKING;
  return pool[Math.abs(seed) % pool.length];
}
