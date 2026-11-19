/**
 * 新托福 100 高频词库（按主题分类，参考主流托福词书的分层与选题方式：
 * 《TOEFL 词汇精选》的高频分级思路、《词以类记》的学科主题分类，以及 ETS 官方指南
 * 里反复出现的学术动词/形容词；释义、记忆法与例句为本项目原创撰写）。
 *
 * tier:
 *   basic    — 四级到托福的过渡词（冲 90 之前必须清掉）
 *   core     — 托福阅读/听力高频学术词（90–100 的主力）
 *   advanced — 冲 100+ 的拉分词（学术写作与讲座里的"高级替换"）
 */

export type WordTier = 'basic' | 'core' | 'advanced';

export interface LexWord {
  term: string;
  ipa: string;
  pos: string;
  cn: string;
  /** 记忆法：词根词缀或联想，尽量一句话说透 */
  mnemonic: string;
  example: string;
  exampleCn: string;
  /** 同义替换，托福阅读最爱考这个 */
  syn: string[];
  theme: string;
  tier: WordTier;
}

export const TOEFL_WORDS: LexWord[] = [
  // ---------- basic ----------
  {
    term: 'alter', ipa: '/ˈɔːltər/', pos: 'v.', cn: '改变；改动',
    mnemonic: 'alter = 其他的 → 变成"另一个样子"，比 change 更书面。',
    example: 'Human activity has altered the river\'s course over two centuries.',
    exampleCn: '两个世纪以来，人类活动改变了这条河的河道。',
    syn: ['modify', 'change'], theme: '地球与环境', tier: 'basic',
  },
  {
    term: 'ambiguous', ipa: '/æmˈbɪɡjuəs/', pos: 'adj.', cn: '模棱两可的',
    mnemonic: 'ambi(两边) + ag(做) → 两边都能解释，所以含糊。',
    example: 'The fossil record is ambiguous about how the species moved.',
    exampleCn: '化石记录无法明确说明这个物种如何移动。',
    syn: ['unclear', 'vague'], theme: '学术方法', tier: 'basic',
  },
  {
    term: 'annual', ipa: '/ˈænjuəl/', pos: 'adj.', cn: '每年的',
    mnemonic: 'ann = 年（anniversary 周年），annual = 一年一次的。',
    example: 'Annual rainfall in the region has fallen by a fifth.',
    exampleCn: '该地区的年降水量下降了五分之一。',
    syn: ['yearly'], theme: '地球与环境', tier: 'basic',
  },
  {
    term: 'assess', ipa: '/əˈses/', pos: 'v.', cn: '评估；估价',
    mnemonic: 'as + sess(坐) → 坐下来定税 → 评估。托福里常跟 risk / impact 搭配。',
    example: 'Researchers assess the risk before releasing a species.',
    exampleCn: '研究人员在放归物种之前评估风险。',
    syn: ['evaluate', 'gauge'], theme: '学术方法', tier: 'basic',
  },
  {
    term: 'assume', ipa: '/əˈsuːm/', pos: 'v.', cn: '假定；承担',
    mnemonic: 'as + sum(拿) → 先把结论"拿"过来当前提。',
    example: 'The model assumes a constant temperature.',
    exampleCn: '该模型假定温度恒定。',
    syn: ['presume', 'suppose'], theme: '学术方法', tier: 'basic',
  },
  {
    term: 'attribute', ipa: '/əˈtrɪbjuːt/', pos: 'v.', cn: '把…归因于',
    mnemonic: 'at + tribut(给) → 把原因"给"某个因素。常考 attribute A to B。',
    example: 'They attribute the decline to pesticide use.',
    exampleCn: '他们把数量下降归因于农药使用。',
    syn: ['ascribe'], theme: '学术方法', tier: 'basic',
  },
  {
    term: 'bias', ipa: '/ˈbaɪəs/', pos: 'n.', cn: '偏差；偏见',
    mnemonic: '想象天平一边沉下去 → 结果就偏了。',
    example: 'Small samples introduce bias into the estimate.',
    exampleCn: '小样本会给估计带来偏差。',
    syn: ['distortion'], theme: '学术方法', tier: 'basic',
  },
  {
    term: 'cease', ipa: '/siːs/', pos: 'v.', cn: '停止',
    mnemonic: 'cease 是"停"，seize 是"抓"——只差一个字母，别混。',
    example: 'The volcano ceased erupting after three weeks.',
    exampleCn: '这座火山在三周后停止喷发。',
    syn: ['stop', 'halt'], theme: '地球与环境', tier: 'basic',
  },
  {
    term: 'coherent', ipa: '/koʊˈhɪrənt/', pos: 'adj.', cn: '连贯的；条理清楚的',
    mnemonic: 'co(一起) + her(粘) → 粘在一起，所以连贯。',
    example: 'The paper offers a coherent explanation of the pattern.',
    exampleCn: '这篇论文对这一模式给出了连贯的解释。',
    syn: ['logical', 'consistent'], theme: '学术方法', tier: 'basic',
  },
  {
    term: 'coincide', ipa: '/ˌkoʊɪnˈsaɪd/', pos: 'v.', cn: '同时发生；一致',
    mnemonic: 'co + incid(落) → 落在同一个点上。',
    example: 'The population peaks coincide with the dry season.',
    exampleCn: '种群数量高峰与旱季同时出现。',
    syn: ['correspond'], theme: '生命科学', tier: 'basic',
  },
  {
    term: 'compile', ipa: '/kəmˈpaɪl/', pos: 'v.', cn: '汇编；编纂',
    mnemonic: 'com(一起) + pile(堆) → 把材料堆到一起。',
    example: 'The team compiled a century of weather records.',
    exampleCn: '团队汇编了一百年的气象记录。',
    syn: ['gather', 'collect'], theme: '学术方法', tier: 'basic',
  },
  {
    term: 'conceal', ipa: '/kənˈsiːl/', pos: 'v.', cn: '隐藏；掩盖',
    mnemonic: 'con + ceal(=hide) → 完全盖住。',
    example: 'The moth\'s coloring conceals it against tree bark.',
    exampleCn: '这只蛾的体色让它在树皮上隐形。',
    syn: ['hide', 'mask'], theme: '生命科学', tier: 'basic',
  },
  {
    term: 'confine', ipa: '/kənˈfaɪn/', pos: 'v.', cn: '限制；局限于',
    mnemonic: 'con + fine(边界) → 关在边界里面。',
    example: 'The species is confined to a single island.',
    exampleCn: '该物种仅分布于一座岛屿。',
    syn: ['restrict', 'limit'], theme: '生命科学', tier: 'basic',
  },
  {
    term: 'conspicuous', ipa: '/kənˈspɪkjuəs/', pos: 'adj.', cn: '显眼的；引人注目的',
    mnemonic: 'con + spic(看) → 一眼就能看见（inconspicuous 是不显眼）。',
    example: 'Males develop a conspicuous red patch on the wing.',
    exampleCn: '雄鸟翅膀上会长出一块显眼的红斑。',
    syn: ['noticeable', 'prominent'], theme: '生命科学', tier: 'basic',
  },
  {
    term: 'constitute', ipa: '/ˈkɑːnstɪtuːt/', pos: 'v.', cn: '构成；组成',
    mnemonic: 'con + stitute(建立) → 一起立起来就是构成。',
    example: 'Water constitutes about seventy percent of the body.',
    exampleCn: '水约占人体重量的百分之七十。',
    syn: ['compose', 'form'], theme: '学术方法', tier: 'basic',
  },
  {
    term: 'contemporary', ipa: '/kənˈtempəreri/', pos: 'adj.', cn: '同时代的；当代的',
    mnemonic: 'con + tempor(时间) → 处于同一时间。',
    example: 'Contemporary accounts describe a much colder winter.',
    exampleCn: '同时代的记述记载了一个冷得多的冬天。',
    syn: ['concurrent'], theme: '艺术与人文', tier: 'basic',
  },
  {
    term: 'contradict', ipa: '/ˌkɑːntrəˈdɪkt/', pos: 'v.', cn: '反驳；与…矛盾',
    mnemonic: 'contra(反) + dict(说) → 反着说。',
    example: 'The new fossil contradicts the earlier timeline.',
    exampleCn: '这块新化石与早先的年代序列相矛盾。',
    syn: ['refute', 'conflict'], theme: '学术方法', tier: 'basic',
  },
  {
    term: 'convert', ipa: '/kənˈvɜːrt/', pos: 'v.', cn: '转化；改换',
    mnemonic: 'con + vert(转) → 转过来。托福常考"能量/单位换算"。',
    example: 'Plants convert sunlight into chemical energy.',
    exampleCn: '植物把阳光转化为化学能。',
    syn: ['transform'], theme: '生命科学', tier: 'basic',
  },
  {
    term: 'crucial', ipa: '/ˈkruːʃl/', pos: 'adj.', cn: '关键的；至关重要的',
    mnemonic: '联想 cross(十字路口) → 决定走向的那个点。',
    example: 'Timing is crucial for seed germination.',
    exampleCn: '时机对种子萌发至关重要。',
    syn: ['critical', 'vital'], theme: '学术方法', tier: 'basic',
  },
  {
    term: 'decline', ipa: '/dɪˈklaɪn/', pos: 'v./n.', cn: '下降；拒绝',
    mnemonic: 'de(向下) + clin(倾斜) → 往下斜。',
    example: 'Bee populations have declined sharply since 1990.',
    exampleCn: '自 1990 年以来蜜蜂种群数量急剧下降。',
    syn: ['decrease', 'diminish'], theme: '生命科学', tier: 'basic',
  },
  {
    term: 'derive', ipa: '/dɪˈraɪv/', pos: 'v.', cn: '源自；获得',
    mnemonic: 'de + riv(河流) → 从河里引水 → 来源。',
    example: 'The word derives from an ancient Greek root.',
    exampleCn: '这个词源自一个古希腊词根。',
    syn: ['originate'], theme: '艺术与人文', tier: 'basic',
  },
  {
    term: 'diminish', ipa: '/dɪˈmɪnɪʃ/', pos: 'v.', cn: '减少；削弱',
    mnemonic: 'di + min(小) → 变小。',
    example: 'Bright light diminishes the effect of the hormone.',
    exampleCn: '强光会削弱这种激素的作用。',
    syn: ['reduce', 'lessen'], theme: '生命科学', tier: 'basic',
  },
  {
    term: 'distinct', ipa: '/dɪˈstɪŋkt/', pos: 'adj.', cn: '明显的；截然不同的',
    mnemonic: 'di + stinct(刺) → 刺出来，所以显眼、与众不同。',
    example: 'The cliff exposes two distinct layers of rock.',
    exampleCn: '这处崖壁露出两个截然不同的岩层。',
    syn: ['separate', 'clear'], theme: '地球与环境', tier: 'basic',
  },
  {
    term: 'diverse', ipa: '/daɪˈvɜːrs/', pos: 'adj.', cn: '多样的；不同的',
    mnemonic: 'di + verse(转) → 转向各个方向。',
    example: 'The island supports a diverse set of habitats.',
    exampleCn: '这座岛拥有多样化的生境。',
    syn: ['varied'], theme: '生命科学', tier: 'basic',
  },
  {
    term: 'dominate', ipa: '/ˈdɑːmɪneɪt/', pos: 'v.', cn: '支配；占主导',
    mnemonic: 'domin(主人) + ate → 当主人。',
    example: 'Grasses dominate the landscape after a fire.',
    exampleCn: '火灾之后草本植物在该地区占主导。',
    syn: ['prevail'], theme: '生命科学', tier: 'basic',
  },
  {
    term: 'elaborate', ipa: '/ɪˈlæbərət/', pos: 'adj./v.', cn: '精细的；详述',
    mnemonic: 'e + labor(劳动) → 花了功夫做出来的，所以精细。',
    example: 'The bird builds an elaborate courtship display.',
    exampleCn: '这种鸟会做出精细的求偶展示。',
    syn: ['intricate', 'detailed'], theme: '生命科学', tier: 'basic',
  },
  {
    term: 'eliminate', ipa: '/ɪˈlɪmɪneɪt/', pos: 'v.', cn: '消除；排除',
    mnemonic: 'e + limin(门槛) → 赶出门外。',
    example: 'The drug eliminates the parasite within days.',
    exampleCn: '这种药几天内就能清除寄生虫。',
    syn: ['remove', 'eradicate'], theme: '生命科学', tier: 'basic',
  },
  {
    term: 'emerge', ipa: '/ɪˈmɜːrdʒ/', pos: 'v.', cn: '出现；显露',
    mnemonic: 'e(出) + merge(沉) → 从水里浮出来。',
    example: 'New evidence emerged from a later excavation.',
    exampleCn: '后来的发掘中出现了新证据。',
    syn: ['appear', 'surface'], theme: '学术方法', tier: 'basic',
  },
  {
    term: 'endure', ipa: '/ɪnˈdʊr/', pos: 'v.', cn: '忍受；持续',
    mnemonic: 'en + dur(硬) → 硬撑下去。',
    example: 'The seeds endure extreme cold for decades.',
    exampleCn: '这些种子能耐受极端低温数十年。',
    syn: ['withstand', 'persist'], theme: '生命科学', tier: 'basic',
  },

  // ---------- core ----------
  {
    term: 'abundant', ipa: '/əˈbʌndənt/', pos: 'adj.', cn: '丰富的；大量的',
    mnemonic: 'ab + und(波浪) + ant → 像波浪一样涌来。',
    example: 'Fossils are abundant in this layer of shale.',
    exampleCn: '这层页岩中化石非常丰富。',
    syn: ['plentiful', 'ample'], theme: '地球与环境', tier: 'core',
  },
  {
    term: 'accumulate', ipa: '/əˈkjuːmjəleɪt/', pos: 'v.', cn: '积累；堆积',
    mnemonic: 'ac + cumul(堆) → 一层层堆起来。',
    example: 'Sediment accumulates slowly on the sea floor.',
    exampleCn: '沉积物在海底缓慢堆积。',
    syn: ['build up'], theme: '地球与环境', tier: 'core',
  },
  {
    term: 'adjacent', ipa: '/əˈdʒeɪsnt/', pos: 'adj.', cn: '邻近的；毗连的',
    mnemonic: 'ad + jac(躺) → 躺在旁边。',
    example: 'The adjacent valley receives twice as much rain.',
    exampleCn: '邻近的河谷降水量是这里的两倍。',
    syn: ['neighboring', 'adjoining'], theme: '地球与环境', tier: 'core',
  },
  {
    term: 'advocate', ipa: '/ˈædvəkeɪt/', pos: 'v./n.', cn: '主张；拥护者',
    mnemonic: 'ad + voc(喊) → 为某件事发声。',
    example: 'The authors advocate stricter limits on fishing.',
    exampleCn: '作者主张对捕捞实行更严格的限制。',
    syn: ['champion', 'support'], theme: '经济与社会', tier: 'core',
  },
  {
    term: 'allocate', ipa: '/ˈæləkeɪt/', pos: 'v.', cn: '分配；配置',
    mnemonic: 'al + loc(地方) → 把资源安排到位置上。',
    example: 'The brain allocates more resources to potential threats.',
    exampleCn: '大脑会把更多资源分配给潜在威胁。',
    syn: ['assign', 'distribute'], theme: '心理与认知', tier: 'core',
  },
  {
    term: 'analogy', ipa: '/əˈnælədʒi/', pos: 'n.', cn: '类比；比拟',
    mnemonic: 'ana(按照) + log(比例) → 按比例对应过去。',
    example: 'The eye is often explained by analogy to a camera.',
    exampleCn: '眼睛常被类比为照相机来解释。',
    syn: ['comparison'], theme: '学术方法', tier: 'core',
  },
  {
    term: 'anomaly', ipa: '/əˈnɑːməli/', pos: 'n.', cn: '异常；反常现象',
    mnemonic: 'a(不) + nom(规则) → 不合规律的东西。',
    example: 'The warm winter was an anomaly in the record.',
    exampleCn: '那个暖冬在记录中属于异常。',
    syn: ['irregularity'], theme: '学术方法', tier: 'core',
  },
  {
    term: 'arbitrary', ipa: '/ˈɑːrbɪtreri/', pos: 'adj.', cn: '任意的；武断的',
    mnemonic: 'arbitr(裁决) → 全凭裁决者喜好，没有客观标准。',
    example: 'The boundary between the two periods is arbitrary.',
    exampleCn: '这两个时期之间的分界是人为划定的。',
    syn: ['random'], theme: '学术方法', tier: 'core',
  },
  {
    term: 'articulate', ipa: '/ɑːrˈtɪkjuleɪt/', pos: 'v.', cn: '清晰表达',
    mnemonic: 'articul(关节) → 一节一节说得清清楚楚。',
    example: 'He articulated the hypothesis in a single sentence.',
    exampleCn: '他用一句话清晰地表述了假设。',
    syn: ['express'], theme: '学术方法', tier: 'core',
  },
  {
    term: 'assert', ipa: '/əˈsɜːrt/', pos: 'v.', cn: '断言；坚持认为',
    mnemonic: 'as + sert(连接) → 把话说死、钉住。',
    example: 'The paper asserts a causal link between the two events.',
    exampleCn: '该论文断言两件事之间存在因果联系。',
    syn: ['claim', 'maintain'], theme: '学术方法', tier: 'core',
  },
  {
    term: 'catalyst', ipa: '/ˈkætəlɪst/', pos: 'n.', cn: '催化剂；促因',
    mnemonic: 'cata(向下) + lyst(松开) → 让反应"松开"加速。',
    example: 'Enzymes act as catalysts in digestion.',
    exampleCn: '酶在消化过程中充当催化剂。',
    syn: ['trigger'], theme: '物理与工程', tier: 'core',
  },
  {
    term: 'collapse', ipa: '/kəˈlæps/', pos: 'v./n.', cn: '崩塌；崩溃',
    mnemonic: 'col + lapse(滑) → 一起滑落。',
    example: 'The colony collapsed within a single season.',
    exampleCn: '这个群体在一个季节内就崩溃了。',
    syn: ['breakdown'], theme: '生命科学', tier: 'core',
  },
  {
    term: 'commodity', ipa: '/kəˈmɑːdəti/', pos: 'n.', cn: '商品；大宗物资',
    mnemonic: 'com + mod(量) → 按量交易的东西。',
    example: 'Grain became a global commodity in the nineteenth century.',
    exampleCn: '粮食在十九世纪成为全球性商品。',
    syn: ['good'], theme: '经济与社会', tier: 'core',
  },
  {
    term: 'compatible', ipa: '/kəmˈpætəbl/', pos: 'adj.', cn: '兼容的；一致的',
    mnemonic: 'com + pati(忍受) → 能一起忍受，所以兼容。',
    example: 'The two datasets are compatible once units are converted.',
    exampleCn: '换算单位之后，这两组数据是一致的。',
    syn: ['consistent'], theme: '学术方法', tier: 'core',
  },
  {
    term: 'compensate', ipa: '/ˈkɑːmpenseɪt/', pos: 'v.', cn: '补偿；抵消',
    mnemonic: 'com + pens(称重) → 两边一起称平。',
    example: 'The body compensates for water loss by reducing urine.',
    exampleCn: '身体通过减少排尿来补偿水分流失。',
    syn: ['offset'], theme: '生命科学', tier: 'core',
  },
  {
    term: 'comprise', ipa: '/kəmˈpraɪz/', pos: 'v.', cn: '由…组成；包含',
    mnemonic: 'com + prise(抓) → 抓在一起就是组成。',
    example: 'The sample comprises three hundred adults.',
    exampleCn: '样本由三百名成年人组成。',
    syn: ['consist of'], theme: '学术方法', tier: 'core',
  },
  {
    term: 'conceive', ipa: '/kənˈsiːv/', pos: 'v.', cn: '构想；想象',
    mnemonic: 'con + ceive(拿) → 把想法拿到脑子里。',
    example: 'It is hard to conceive of a world without ice.',
    exampleCn: '很难想象一个没有冰的世界。',
    syn: ['envision'], theme: '心理与认知', tier: 'core',
  },
  {
    term: 'concurrent', ipa: '/kənˈkɜːrənt/', pos: 'adj.', cn: '同时发生的',
    mnemonic: 'con + curr(跑) → 一起跑。',
    example: 'Concurrent changes in rainfall and temperature were recorded.',
    exampleCn: '记录了降水和温度的同时变化。',
    syn: ['simultaneous'], theme: '学术方法', tier: 'core',
  },
  {
    term: 'consensus', ipa: '/kənˈsensəs/', pos: 'n.', cn: '共识',
    mnemonic: 'con + sens(感觉) → 大家感觉一致。',
    example: 'There is still no consensus on what caused the extinction.',
    exampleCn: '关于灭绝的原因仍无共识。',
    syn: ['agreement'], theme: '学术方法', tier: 'core',
  },
  {
    term: 'constrain', ipa: '/kənˈstreɪn/', pos: 'v.', cn: '限制；约束',
    mnemonic: 'con + strain(拉紧) → 被绑紧了，动不了。',
    example: 'Cold temperatures constrain plant growth at high altitude.',
    exampleCn: '低温限制了高海拔地区的植物生长。',
    syn: ['restrict', 'limit'], theme: '生命科学', tier: 'core',
  },
  {
    term: 'contend', ipa: '/kənˈtend/', pos: 'v.', cn: '主张；争夺',
    mnemonic: 'con + tend(伸) → 各自伸出主张，互不相让。',
    example: 'The authors contend that the effect is real but small.',
    exampleCn: '作者主张这一效应真实存在，但幅度很小。',
    syn: ['argue', 'maintain'], theme: '学术方法', tier: 'core',
  },
  {
    term: 'converge', ipa: '/kənˈvɜːrdʒ/', pos: 'v.', cn: '汇聚；趋同',
    mnemonic: 'con + verge(转) → 都转向同一个点（反义 diverge）。',
    example: 'Two rivers converge just above the falls.',
    exampleCn: '两条河在瀑布上游不远处汇合。',
    syn: ['meet'], theme: '地球与环境', tier: 'core',
  },
  {
    term: 'correlate', ipa: '/ˈkɔːrəleɪt/', pos: 'v.', cn: '相关联',
    mnemonic: 'co + relate → 彼此有关系，但注意不等于因果。',
    example: 'Body size correlates strongly with latitude.',
    exampleCn: '体型与纬度高度相关。',
    syn: ['correspond'], theme: '学术方法', tier: 'core',
  },
  {
    term: 'credibility', ipa: '/ˌkredəˈbɪləti/', pos: 'n.', cn: '可信度',
    mnemonic: 'cred(相信) + ibility → 值得相信的程度。',
    example: 'The claim lost credibility when the data were rechecked.',
    exampleCn: '数据重核之后，这一说法失去了可信度。',
    syn: ['plausibility'], theme: '学术方法', tier: 'core',
  },
  {
    term: 'deduce', ipa: '/dɪˈduːs/', pos: 'v.', cn: '推断；演绎',
    mnemonic: 'de(向下) + duc(引) → 从前提引出结论。',
    example: 'From the tracks they deduced the animal\'s weight.',
    exampleCn: '他们根据足迹推断出这只动物的体重。',
    syn: ['infer'], theme: '学术方法', tier: 'core',
  },
  {
    term: 'deficiency', ipa: '/dɪˈfɪʃnsi/', pos: 'n.', cn: '缺乏；不足',
    mnemonic: 'de + fic(做) → 没做够 → 缺。',
    example: 'Iron deficiency slows growth in children.',
    exampleCn: '缺铁会延缓儿童生长。',
    syn: ['shortage', 'lack'], theme: '生命科学', tier: 'core',
  },
  {
    term: 'degrade', ipa: '/dɪˈɡreɪd/', pos: 'v.', cn: '降解；退化',
    mnemonic: 'de(向下) + grade(等级) → 等级往下掉。',
    example: 'Plastics degrade very slowly in cold water.',
    exampleCn: '塑料在冷水中降解得非常慢。',
    syn: ['deteriorate'], theme: '地球与环境', tier: 'core',
  },
  {
    term: 'deliberate', ipa: '/dɪˈlɪbərət/', pos: 'adj.', cn: '刻意的；深思熟虑的',
    mnemonic: 'de + liber(称量) → 反复称量过才做，所以是有意的。',
    example: 'The change was a deliberate response to drought.',
    exampleCn: '这一改变是对干旱的刻意回应。',
    syn: ['intentional'], theme: '心理与认知', tier: 'core',
  },
  {
    term: 'denote', ipa: '/dɪˈnoʊt/', pos: 'v.', cn: '表示；标志',
    mnemonic: 'de + not(标记) → 打上标记指代某物。',
    example: 'On the map, red lines denote active faults.',
    exampleCn: '在地图上，红线表示活动断层。',
    syn: ['indicate'], theme: '学术方法', tier: 'core',
  },
  {
    term: 'deplete', ipa: '/dɪˈpliːt/', pos: 'v.', cn: '耗尽；大量消耗',
    mnemonic: 'de + plet(满) → 把满的掏空。',
    example: 'Overfishing has depleted cod stocks.',
    exampleCn: '过度捕捞已使鳕鱼资源枯竭。',
    syn: ['exhaust'], theme: '经济与社会', tier: 'core',
  },
  {
    term: 'deprive', ipa: '/dɪˈpraɪv/', pos: 'v.', cn: '剥夺；使丧失',
    mnemonic: 'de + priv(单个) → 让人失去。常考 deprive sb of sth。',
    example: 'A plant deprived of light will not flower.',
    exampleCn: '得不到光照的植物不会开花。',
    syn: ['strip'], theme: '生命科学', tier: 'core',
  },
  {
    term: 'deteriorate', ipa: '/dɪˈtɪriəreɪt/', pos: 'v.', cn: '恶化；变坏',
    mnemonic: 'deterior(更坏) + ate → 越变越坏。',
    example: 'Air quality deteriorated as the city grew.',
    exampleCn: '随着城市扩张，空气质量不断恶化。',
    syn: ['worsen'], theme: '地球与环境', tier: 'core',
  },
  {
    term: 'deviate', ipa: '/ˈdiːvieɪt/', pos: 'v.', cn: '偏离；背离',
    mnemonic: 'de + via(路) → 离开原路。',
    example: 'The comet deviates slightly from its predicted orbit.',
    exampleCn: '这颗彗星的轨道与预测略有偏离。',
    syn: ['diverge'], theme: '地球与环境', tier: 'core',
  },
  {
    term: 'diffuse', ipa: '/dɪˈfjuːz/', pos: 'v.', cn: '扩散；弥散',
    mnemonic: 'dif(分开) + fuse(流) → 向四周流开。',
    example: 'Oxygen diffuses from the lungs into the blood.',
    exampleCn: '氧气从肺部扩散进血液。',
    syn: ['spread'], theme: '生命科学', tier: 'core',
  },
  {
    term: 'discard', ipa: '/dɪsˈkɑːrd/', pos: 'v.', cn: '丢弃；摒弃',
    mnemonic: 'dis + card(牌) → 把手里不要的牌扔掉。',
    example: 'They discarded the older model after new data arrived.',
    exampleCn: '新数据出现后，他们放弃了旧模型。',
    syn: ['abandon'], theme: '学术方法', tier: 'core',
  },
  {
    term: 'discrete', ipa: '/dɪˈskriːt/', pos: 'adj.', cn: '离散的；分开的',
    mnemonic: 'dis + cret(分开) → 一个个独立的（区别于 discreet 谨慎的）。',
    example: 'Development passes through discrete stages.',
    exampleCn: '发育要经过几个彼此独立的阶段。',
    syn: ['separate'], theme: '生命科学', tier: 'core',
  },
  {
    term: 'disperse', ipa: '/dɪˈspɜːrs/', pos: 'v.', cn: '散开；传播',
    mnemonic: 'di + sperse(散) → 四散。',
    example: 'Seeds disperse mainly by wind and birds.',
    exampleCn: '种子主要通过风和鸟类传播。',
    syn: ['scatter'], theme: '生命科学', tier: 'core',
  },
  {
    term: 'disrupt', ipa: '/dɪsˈrʌpt/', pos: 'v.', cn: '扰乱；打断',
    mnemonic: 'dis + rupt(断) → 把延续的东西打断。',
    example: 'Dams disrupt the flow of sediment downstream.',
    exampleCn: '大坝打断了下游的泥沙输送。',
    syn: ['disturb'], theme: '地球与环境', tier: 'core',
  },
  {
    term: 'distort', ipa: '/dɪˈstɔːrt/', pos: 'v.', cn: '扭曲；歪曲',
    mnemonic: 'dis + tort(扭) → 扭歪了。',
    example: 'Heat distorts the climate record of the past century.',
    exampleCn: '热量会扭曲过去一个世纪的气候记录。',
    syn: ['twist'], theme: '学术方法', tier: 'core',
  },
  {
    term: 'diverge', ipa: '/daɪˈvɜːrdʒ/', pos: 'v.', cn: '分歧；分叉',
    mnemonic: 'di + verge(转) → 转往不同方向。',
    example: 'Their conclusions diverge on one key point.',
    exampleCn: '他们的结论在一个关键点上出现分歧。',
    syn: ['differ'], theme: '学术方法', tier: 'core',
  },
  {
    term: 'doctrine', ipa: '/ˈdɑːktrɪn/', pos: 'n.', cn: '学说；教义',
    mnemonic: 'doc(教) + trine → 被教授的一套说法。',
    example: 'Uniformitarianism was a radical doctrine in its day.',
    exampleCn: '均变论在当年是一种激进的学说。',
    syn: ['theory'], theme: '学术方法', tier: 'core',
  },
  {
    term: 'drastic', ipa: '/ˈdræstɪk/', pos: 'adj.', cn: '剧烈的；极端的',
    mnemonic: '联想 drama → 戏剧性的、幅度很大的变化。',
    example: 'The lake level dropped in a drastic fashion.',
    exampleCn: '湖面出现了急剧下降。',
    syn: ['severe', 'extreme'], theme: '地球与环境', tier: 'core',
  },
  {
    term: 'dynamic', ipa: '/daɪˈnæmɪk/', pos: 'adj.', cn: '动态的；有活力的',
    mnemonic: 'dynam(力) → 一直有力在推动。',
    example: 'The two populations are in a dynamic equilibrium.',
    exampleCn: '这两个种群处于动态平衡中。',
    syn: ['active'], theme: '生命科学', tier: 'core',
  },
  {
    term: 'empirical', ipa: '/ɪmˈpɪrɪkl/', pos: 'adj.', cn: '实证的；经验的',
    mnemonic: 'em + pir(试验) → 试出来的，不是想出来的。',
    example: 'The claim rests on empirical evidence, not on theory alone.',
    exampleCn: '这一主张依靠实证证据，而不只是理论。',
    syn: ['experimental'], theme: '学术方法', tier: 'core',
  },

  // ---------- advanced ----------
  {
    term: 'alleviate', ipa: '/əˈliːvieɪt/', pos: 'v.', cn: '缓解；减轻',
    mnemonic: 'al + lev(轻) → 让变轻。',
    example: 'The drug alleviates symptoms but does not cure the disease.',
    exampleCn: '这种药能缓解症状，但无法治愈疾病。',
    syn: ['mitigate', 'ease'], theme: '生命科学', tier: 'advanced',
  },
  {
    term: 'ambivalent', ipa: '/æmˈbɪvələnt/', pos: 'adj.', cn: '矛盾心理的',
    mnemonic: 'ambi(两边) + val(价值) → 两边都看有价值，难以取舍。',
    example: 'Farmers remain ambivalent about the new irrigation scheme.',
    exampleCn: '农民对新的灌溉方案仍态度矛盾。',
    syn: ['conflicted'], theme: '心理与认知', tier: 'advanced',
  },
  {
    term: 'ameliorate', ipa: '/əˈmiːliəreɪt/', pos: 'v.', cn: '改善；缓和',
    mnemonic: 'a + melior(更好) → 让它变好。',
    example: 'Irrigation ameliorated the effects of the drought.',
    exampleCn: '灌溉缓和了干旱的影响。',
    syn: ['improve'], theme: '经济与社会', tier: 'advanced',
  },
  {
    term: 'amplify', ipa: '/ˈæmplɪfaɪ/', pos: 'v.', cn: '放大；增强',
    mnemonic: 'ampl(大) + ify → 使变大。',
    example: 'The narrow canyon amplifies the sound of the river.',
    exampleCn: '狭窄的峡谷把河水声放大了。',
    syn: ['intensify'], theme: '物理与工程', tier: 'advanced',
  },
  {
    term: 'ascertain', ipa: '/ˌæsərˈteɪn/', pos: 'v.', cn: '查明；确定',
    mnemonic: 'as + cert(确定) → 让事情确定下来。',
    example: 'They could not ascertain the age of the bones.',
    exampleCn: '他们无法确定这些骨头的年代。',
    syn: ['determine'], theme: '学术方法', tier: 'advanced',
  },
  {
    term: 'assimilate', ipa: '/əˈsɪməleɪt/', pos: 'v.', cn: '吸收；同化',
    mnemonic: 'as + simil(相似) → 吃得和身体相似。',
    example: 'Plants assimilate carbon dioxide during daylight.',
    exampleCn: '植物在白天吸收二氧化碳。',
    syn: ['absorb'], theme: '生命科学', tier: 'advanced',
  },
  {
    term: 'augment', ipa: '/ɔːɡˈment/', pos: 'v.', cn: '增加；增强',
    mnemonic: 'aug(增长) + ment → 往上加。',
    example: 'The team augmented the survey with oral histories.',
    exampleCn: '团队用口述史补充了这次调查。',
    syn: ['supplement'], theme: '学术方法', tier: 'advanced',
  },
  {
    term: 'circumvent', ipa: '/ˌsɜːrkəmˈvent/', pos: 'v.', cn: '规避；绕开',
    mnemonic: 'circum(绕) + vent(来) → 绕着走。',
    example: 'The bird circumvents the barrier by flying higher.',
    exampleCn: '这只鸟飞得更高以绕过障碍。',
    syn: ['bypass'], theme: '生命科学', tier: 'advanced',
  },
  {
    term: 'coalesce', ipa: '/ˌkoʊəˈles/', pos: 'v.', cn: '合并；结合',
    mnemonic: 'co + al + esc → 长到一起。',
    example: 'Droplets coalesce into clouds as air rises.',
    exampleCn: '空气上升时，小水滴合并成云。',
    syn: ['merge'], theme: '地球与环境', tier: 'advanced',
  },
  {
    term: 'cognitive', ipa: '/ˈkɑːɡnətɪv/', pos: 'adj.', cn: '认知的',
    mnemonic: 'cogn(知道) + itive → 与"知道"有关。',
    example: 'Sleep loss raises cognitive load during simple tasks.',
    exampleCn: '睡眠不足会增加简单任务中的认知负荷。',
    syn: ['mental'], theme: '心理与认知', tier: 'advanced',
  },
  {
    term: 'commemorate', ipa: '/kəˈmeməreɪt/', pos: 'v.', cn: '纪念',
    mnemonic: 'com + memor(记忆) → 一起记住。',
    example: 'The mural commemorates a flood that reshaped the town.',
    exampleCn: '这幅壁画纪念一场改变小镇的洪水。',
    syn: ['honor'], theme: '艺术与人文', tier: 'advanced',
  },
  {
    term: 'compelling', ipa: '/kəmˈpelɪŋ/', pos: 'adj.', cn: '有说服力的；引人入胜的',
    mnemonic: 'com + pel(推) → 推着你不得不信。',
    example: 'The authors offer a compelling case for the earlier date.',
    exampleCn: '作者为更早的年代提供了有说服力的论证。',
    syn: ['persuasive'], theme: '学术方法', tier: 'advanced',
  },
  {
    term: 'concede', ipa: '/kənˈsiːd/', pos: 'v.', cn: '承认；让步',
    mnemonic: 'con + cede(走) → 往后退一步。',
    example: 'The author concedes that the sample is small.',
    exampleCn: '作者承认样本量偏小。',
    syn: ['admit'], theme: '学术方法', tier: 'advanced',
  },
  {
    term: 'conducive', ipa: '/kənˈduːsɪv/', pos: 'adj.', cn: '有助于…的',
    mnemonic: 'con + duc(引) → 引向某个结果。常考 conducive to。',
    example: 'Shade is conducive to moss growth.',
    exampleCn: '荫蔽有利于苔藓生长。',
    syn: ['favorable'], theme: '生命科学', tier: 'advanced',
  },
  {
    term: 'congenital', ipa: '/kənˈdʒenɪtl/', pos: 'adj.', cn: '先天的',
    mnemonic: 'con + gen(生) → 与生俱来。',
    example: 'The trait appears to be congenital rather than learned.',
    exampleCn: '这一特征似乎是先天的，而非习得的。',
    syn: ['inborn'], theme: '生命科学', tier: 'advanced',
  },
  {
    term: 'connotation', ipa: '/ˌkɑːnəˈteɪʃn/', pos: 'n.', cn: '内涵；言外之意',
    mnemonic: 'con + not(标记) → 附在词上的额外标记。',
    example: 'The term carries a negative connotation in policy debates.',
    exampleCn: '这个词在政策讨论中带有负面含义。',
    syn: ['implication'], theme: '艺术与人文', tier: 'advanced',
  },
  {
    term: 'corroborate', ipa: '/kəˈrɑːbəreɪt/', pos: 'v.', cn: '证实；佐证',
    mnemonic: 'cor + robor(力量) → 给证据加力。',
    example: 'Two independent studies corroborate the finding.',
    exampleCn: '两项独立研究佐证了这一发现。',
    syn: ['confirm'], theme: '学术方法', tier: 'advanced',
  },
  {
    term: 'culminate', ipa: '/ˈkʌlmɪneɪt/', pos: 'v.', cn: '达到顶点；以…告终',
    mnemonic: 'culmin(顶) + ate → 走到最高点。',
    example: 'The process culminates in a single burst of flowering.',
    exampleCn: '这一过程最终以一次集中开花告终。',
    syn: ['peak'], theme: '生命科学', tier: 'advanced',
  },
  {
    term: 'delineate', ipa: '/dɪˈlɪnieɪt/', pos: 'v.', cn: '描绘；划定',
    mnemonic: 'de + line(线) → 把线画出来。',
    example: 'The map delineates the boundary of the watershed.',
    exampleCn: '这张地图划出了流域的边界。',
    syn: ['outline'], theme: '地球与环境', tier: 'advanced',
  },
  {
    term: 'detrimental', ipa: '/ˌdetrɪˈmentl/', pos: 'adj.', cn: '有害的',
    mnemonic: 'de + ter(磨) → 一点点磨损掉。',
    example: 'Prolonged drought is detrimental to soil health.',
    exampleCn: '长期干旱对土壤健康有害。',
    syn: ['harmful'], theme: '地球与环境', tier: 'advanced',
  },
  {
    term: 'dichotomy', ipa: '/daɪˈkɑːtəmi/', pos: 'n.', cn: '二分法；对立',
    mnemonic: 'dicho(切两半) + tomy(切) → 一刀两半。',
    example: 'The dichotomy between nature and nurture is increasingly blurred.',
    exampleCn: '先天与后天的二分正越来越模糊。',
    syn: ['split'], theme: '学术方法', tier: 'advanced',
  },
  {
    term: 'discern', ipa: '/dɪˈsɜːrn/', pos: 'v.', cn: '辨认；觉察',
    mnemonic: 'dis + cern(筛) → 从一堆里筛出来。',
    example: 'It is hard to discern a pattern in such noisy data.',
    exampleCn: '在如此嘈杂的数据中很难看出规律。',
    syn: ['detect'], theme: '学术方法', tier: 'advanced',
  },
  {
    term: 'discrepancy', ipa: '/dɪsˈkrepənsi/', pos: 'n.', cn: '差异；不一致',
    mnemonic: 'dis + crep(响) → 两边声音不一样。',
    example: 'A discrepancy between the two records prompted a reanalysis.',
    exampleCn: '两份记录之间的出入促使他们重新分析。',
    syn: ['inconsistency'], theme: '学术方法', tier: 'advanced',
  },
  {
    term: 'disseminate', ipa: '/dɪˈsemɪneɪt/', pos: 'v.', cn: '传播；散布',
    mnemonic: 'dis + semin(种子) → 把种子撒出去。',
    example: 'Wind disseminates spores across the forest floor.',
    exampleCn: '风把孢子散布到整个林地。',
    syn: ['spread'], theme: '生命科学', tier: 'advanced',
  },
  {
    term: 'dissipate', ipa: '/ˈdɪsɪpeɪt/', pos: 'v.', cn: '消散；驱散',
    mnemonic: 'dis + sip(扔) → 扔散开。',
    example: 'The morning fog dissipates by noon.',
    exampleCn: '晨雾到中午就散了。',
    syn: ['disperse'], theme: '地球与环境', tier: 'advanced',
  },
  {
    term: 'elicit', ipa: '/ɪˈlɪsɪt/', pos: 'v.', cn: '引出；诱发',
    mnemonic: 'e + licit(诱) → 把反应引出来。',
    example: 'The question elicited a wide range of responses.',
    exampleCn: '这个问题引出了各种各样的回答。',
    syn: ['evoke'], theme: '心理与认知', tier: 'advanced',
  },
  {
    term: 'emulate', ipa: '/ˈemjuleɪt/', pos: 'v.', cn: '效仿；模拟',
    mnemonic: 'emul(竞争) + ate → 努力追平对方。',
    example: 'The robot emulates the way insects walk on sand.',
    exampleCn: '这个机器人模拟昆虫在沙地上行走的方式。',
    syn: ['imitate'], theme: '物理与工程', tier: 'advanced',
  },
  {
    term: 'ephemeral', ipa: '/ɪˈfemərəl/', pos: 'adj.', cn: '短暂的；朝生暮死的',
    mnemonic: 'epi(在) + hemer(日) → 只活一天。',
    example: 'Desert blooms are spectacular but ephemeral.',
    exampleCn: '沙漠花海壮观却短暂。',
    syn: ['fleeting'], theme: '生命科学', tier: 'advanced',
  },
  {
    term: 'plausible', ipa: '/ˈplɔːzəbl/', pos: 'adj.', cn: '看似合理的',
    mnemonic: 'plaus(鼓掌) + ible → 值得鼓掌的说法。',
    example: 'The team proposed a plausible mechanism for the pattern.',
    exampleCn: '团队为这一模式提出了一个看似合理的机制。',
    syn: ['credible'], theme: '学术方法', tier: 'advanced',
  },
  {
    term: 'prevalent', ipa: '/ˈprevələnt/', pos: 'adj.', cn: '普遍的；流行的',
    mnemonic: 'pre + val(强) → 占优势 → 到处都是。',
    example: 'The practice is prevalent in coastal communities.',
    exampleCn: '这种做法在沿海社区很普遍。',
    syn: ['widespread'], theme: '经济与社会', tier: 'advanced',
  },
  {
    term: 'scrutiny', ipa: '/ˈskruːtəni/', pos: 'n.', cn: '仔细审查',
    mnemonic: 'scrut(翻找) → 连垃圾堆都翻一遍。',
    example: 'Under close scrutiny, the estimate did not hold.',
    exampleCn: '经仔细审查，那个估计站不住脚。',
    syn: ['examination'], theme: '学术方法', tier: 'advanced',
  },
  {
    term: 'synthesize', ipa: '/ˈsɪnθəsaɪz/', pos: 'v.', cn: '综合；合成',
    mnemonic: 'syn(一起) + thes(放) → 放在一起成整体。',
    example: 'The review synthesizes forty years of fieldwork.',
    exampleCn: '这篇综述综合了四十年的野外研究。',
    syn: ['integrate'], theme: '学术方法', tier: 'advanced',
  },
  {
    term: 'viable', ipa: '/ˈvaɪəbl/', pos: 'adj.', cn: '可行的；能存活的',
    mnemonic: 'vi(生命) + able → 活得下去的。',
    example: 'Solar power became a viable alternative in the region.',
    exampleCn: '太阳能在该地区成为可行的替代方案。',
    syn: ['feasible'], theme: '经济与社会', tier: 'advanced',
  },
  {
    term: 'warrant', ipa: '/ˈwɔːrənt/', pos: 'v./n.', cn: '使…有必要；授权',
    mnemonic: 'warrant(担保) → 值得担保 → 值得一做。',
    example: 'The anomaly warrants further study.',
    exampleCn: '这一异常值得进一步研究。',
    syn: ['justify'], theme: '学术方法', tier: 'advanced',
  },
];

const LEVEL_TIERS: Record<string, WordTier[]> = {
  hs: ['basic'],
  cet4: ['basic', 'core'],
  cet6: ['core'],
  cet6plus: ['core', 'advanced'],
  tem4: ['advanced', 'core'],
};

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * 按当前水平 + 目标分选词：同一天永远给同一批词（seed 用日期），
 * 不同天换一批；已进过词汇本的词优先排除。
 */
export function pickWords(options: {
  levelId: string;
  targetScore: number;
  seed: string;
  count: number;
  exclude?: Set<string>;
}): LexWord[] {
  const { levelId, targetScore, seed, count, exclude } = options;
  const tiers = [...(LEVEL_TIERS[levelId] ?? ['core'])];
  // 目标 95 分以上，即使基础一般也要开始见"拉分词"
  if (targetScore >= 95 && !tiers.includes('advanced')) tiers.push('advanced');
  if (targetScore >= 100 && !tiers.includes('core')) tiers.push('core');

  const buckets = new Map<WordTier, LexWord[]>();
  const used = new Set<string>();
  for (const tier of tiers) {
    const pool = TOEFL_WORDS.filter(
      (word) => word.tier === tier && !(exclude?.has(word.term) ?? false),
    ).sort((a, b) => hash(seed + a.term) - hash(seed + b.term));
    buckets.set(tier, pool);
  }

  // 按 tier 优先级轮流取，保证"基础词 + 高频核心词"混着来，不会一天全是难词
  const picked: LexWord[] = [];
  let round = 0;
  while (picked.length < count && round < 200) {
    let added = false;
    for (const tier of tiers) {
      const bucket = buckets.get(tier);
      if (!bucket) continue;
      const next = bucket[round];
      if (next && !used.has(next.term)) {
        used.add(next.term);
        picked.push(next);
        added = true;
        if (picked.length >= count) break;
      }
    }
    if (!added) break;
    round += 1;
  }

  // 词库不够时，允许从被排除的词里补（保证页面上至少有内容）
  if (picked.length < count && exclude) {
    const extras = TOEFL_WORDS.filter(
      (word) => tiers.includes(word.tier) && exclude.has(word.term),
    ).sort((a, b) => hash(seed + a.term) - hash(seed + b.term));
    for (const word of extras) {
      if (picked.length >= count) break;
      if (!picked.some((item) => item.term === word.term)) picked.push(word);
    }
  }

  return picked.slice(0, count);
}

export const LEXICON_SOURCE =
  '按主流托福词书的高频分级（《TOEFL 词汇精选》《词以类记》主题分类 + ETS 官方指南学术词）整理';
