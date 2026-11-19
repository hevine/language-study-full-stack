import type { ArticlePayload } from '../domain/types';

/**
 * 演示模式内置精读库（无需大模型即可完整体验流程）。
 * 内容按托福/雅思学术文章结构撰写，配置大模型后会按当日考纲与话题实时生成。
 */
export const EN_LIBRARY: ArticlePayload[] = [
  {
    title: 'How Sleep Rebuilds the Brain',
    body: `Every night, while the body lies still, the brain runs one of its most demanding maintenance programs. During deep sleep, a network of channels surrounding the blood vessels flushes cerebrospinal fluid through brain tissue, carrying away metabolic waste that accumulates during waking hours. Among the substances cleared is amyloid beta, a protein fragment that forms sticky plaques in the brains of people with Alzheimer's disease.

Sleep also appears to consolidate memory. In a series of experiments, researchers asked volunteers to learn pairs of unrelated words in the evening. Those who slept for eight hours remembered roughly twenty percent more pairs the next morning than those who stayed awake. Brain scans showed that the hippocampus, a structure that encodes new experiences, replayed the day's patterns to the neocortex, which stores long-term knowledge. The transfer seems to happen mostly during slow-wave sleep, when the brain produces large, synchronized electrical waves.

None of this means that a single good night can repair weeks of deprivation. Sleep debt accumulates, and the effects on attention are immediate: after seventeen hours awake, reaction times resemble those of a person with a blood alcohol level above the legal driving limit. What the research does suggest is that sleep is not a pause in learning but part of it — an active stage in which the brain decides what to keep.`,
    translation: `每天夜里，当身体静止不动时，大脑却在运行它最耗费资源的维护程序之一。在深度睡眠中，环绕血管的一套通道网络会把脑脊液冲过脑组织，带走清醒时积累的代谢废物。被清除的物质中包括 β- 淀粉样蛋白——一种在阿尔茨海默病患者脑内形成黏性斑块的蛋白碎片。

睡眠似乎还能巩固记忆。在一系列实验中，研究者让志愿者在晚上学习成对的无关联单词。睡满八小时的人次日上午记住的词对，比整夜清醒的人多出约百分之二十。脑成像显示，负责编码新经验的海马体，会把白天的活动模式"重播"给储存长期知识的新皮层。这种转移似乎主要发生在慢波睡眠阶段，此时大脑会产生幅度大而同步的脑电波。

这并不意味着一个好觉就能修复数周的睡眠剥夺。睡眠债会累积，而对注意力的影响是即时的：清醒十七小时后，人的反应时间与血液酒精浓度超过法定驾驶限值的人相当。研究真正提示的是：睡眠不是学习的暂停，而是学习的一部分——是大脑决定"哪些内容值得保留"的主动阶段。`,
    vocab: [
      { term: 'maintenance', reading: '/ˈmeɪntənəns/', pos: 'n.', meaning: '维护；保养', example: 'Routine maintenance keeps the equipment reliable.' },
      { term: 'cerebrospinal', reading: '/ˌserəbroʊˈspaɪnl/', pos: 'adj.', meaning: '脑脊液的', example: 'Cerebrospinal fluid cushions the brain.' },
      { term: 'metabolic', reading: '/ˌmetəˈbɑːlɪk/', pos: 'adj.', meaning: '新陈代谢的', example: 'Metabolic waste builds up during waking hours.' },
      { term: 'accumulate', reading: '/əˈkjuːmjəleɪt/', pos: 'v.', meaning: '积累；堆积', example: 'Debris accumulates in the corners of the harbor.' },
      { term: 'fragment', reading: '/ˈfræɡmənt/', pos: 'n.', meaning: '碎片；片段', example: 'Archaeologists found a fragment of pottery.' },
      { term: 'consolidate', reading: '/kənˈsɑːlɪdeɪt/', pos: 'v.', meaning: '巩固；加强', example: 'Reviewing notes helps consolidate new knowledge.' },
      { term: 'encode', reading: '/ɪnˈkoʊd/', pos: 'v.', meaning: '编码；将…转化为信号', example: 'The hippocampus encodes the sequence of events.' },
      { term: 'synchronized', reading: '/ˈsɪŋkrənaɪzd/', pos: 'adj.', meaning: '同步的', example: 'Synchronized waves appear in deep sleep.' },
      { term: 'deprivation', reading: '/ˌdeprɪˈveɪʃn/', pos: 'n.', meaning: '剥夺；匮乏', example: 'Sleep deprivation impairs judgment.' },
      { term: 'resemble', reading: '/rɪˈzembl/', pos: 'v.', meaning: '与…相似', example: 'The pattern resembles a spiral galaxy.' },
    ],
    questions: [
      {
        prompt: 'According to the passage, what is the primary function of the fluid movement described in paragraph 1?',
        options: [
          'To cool brain tissue during sleep',
          'To remove metabolic waste that builds up while awake',
          'To deliver nutrients to the hippocampus',
          'To trigger the production of amyloid beta',
        ],
        answer: 1,
        explain: '第一段明确说 flushes cerebrospinal fluid…carrying away metabolic waste that accumulates during waking hours.',
      },
      {
        prompt: 'The experiment with word pairs is used to illustrate that',
        options: [
          'sleep improves the consolidation of newly learned information',
          'memory depends mainly on the emotional content of words',
          'people learn faster in the evening than in the morning',
          'staying awake increases creativity',
        ],
        answer: 0,
        explain: '该实验是对上一句 "Sleep also appears to consolidate memory" 的例证。',
      },
      {
        prompt: 'The word "resemble" in paragraph 3 is closest in meaning to',
        options: ['exceed', 'are similar to', 'replace', 'depend on'],
        answer: 1,
        explain: 'resemble = be similar to，与"相当、相似"对应。',
      },
      {
        prompt: 'What can be inferred about slow-wave sleep from the passage?',
        options: [
          'It is the stage in which the body repairs muscle tissue.',
          'It occurs only in the first hour of the night.',
          'It plays a central role in transferring memories to long-term storage.',
          'It is reduced when people learn unrelated word pairs.',
        ],
        answer: 2,
        explain: '文中说记忆转移 "seems to happen mostly during slow-wave sleep"，可推知该阶段对长期储存至关重要。',
      },
    ],
    readingScript: {
      segments: [
        {
          text: "Every night, while the body lies still, the brain runs one of its most demanding maintenance programs.",
          translation: '每天夜里，当身体静止不动时，大脑却在运行它最耗费资源的维护程序之一。',
          tips: ['demanding 重读，表示"高强度的"', 'runs 在此为"运行"，轻读'],
        },
        {
          text: 'During deep sleep, a network of channels surrounding the blood vessels flushes cerebrospinal fluid through brain tissue, carrying away metabolic waste that accumulates during waking hours.',
          translation: '在深度睡眠中，环绕血管的通道网络把脑脊液冲过脑组织，带走清醒时积累的代谢废物。',
          tips: ['长句先断在 tissue 后，carrying away… 为伴随状语', 'flushes 与 accumulates 形成对照，重读'],
        },
        {
          text: "Sleep also appears to consolidate memory.",
          translation: '睡眠似乎还能巩固记忆。',
          tips: ['appears to 弱读，句子重心在 consolidate 上'],
        },
        {
          text: 'What the research does suggest is that sleep is not a pause in learning but part of it — an active stage in which the brain decides what to keep.',
          translation: '研究真正提示的是：睡眠不是学习的暂停，而是学习的一部分——是大脑决定"哪些内容值得保留"的主动阶段。',
          tips: ['does 为强调助动词，需重读', '破折号前停顿约 1 拍，an active stage 加重'],
        },
      ],
    },
  },
  {
    title: 'The Repair Café',
    body: `The first Repair Café opened in Amsterdam in 2009, in a small theatre hall rented for a few hours on a Saturday. Its founder, Martine Postma, had grown frustrated by the number of household appliances thrown away for want of a five-minute fix. She placed an advertisement inviting people to bring broken toasters, lamps and bicycles, and to sit with a volunteer who would help them mend the item themselves. Twenty people came. Today there are more than 2,500 such cafés worldwide.

The appeal is partly financial, but organisers insist that it is mostly social. In a typical session, retired engineers work alongside students, and the conversation drifts from wiring to grandchildren. Participants pay nothing for the repair, though many leave a small donation. What they cannot do is drop off an object and collect it later; the rule is that owners must stay and watch, so that the skill is transferred rather than the product merely fixed.

Critics point out that the movement cannot offset the volume of electronic waste, which reached 62 million tonnes in 2022. Yet the cafés do something that recycling plants cannot: they change the calculation in a person's head. Once you have seen the inside of a kettle, throwing it away feels less like discarding rubbish and more like giving up.`,
    translation: `第一家"修理咖啡馆"于 2009 年在阿姆斯特丹开张，场地是周六租用几个小时的小剧场。创始人玛蒂娜·波斯特玛看着一件件家用电器因为"缺五分钟的修理"而被丢弃，愈发难以忍受。她登出广告，邀请人们带上坏掉的烤面包机、台灯和自行车，与志愿者坐在一起，自己动手把东西修好。来了二十个人。如今，全球已有两千五百多家这样的咖啡馆。

它的吸引力部分是经济上的，但组织者坚持认为，主要还是社交层面的。在典型的一场活动里，退休工程师与学生并肩工作，话题从线路聊到孙辈。参与者不用为修理付费，不过很多人会留下一点捐款。他们唯一不能做的是"把东西放下、日后来取"——规矩是物主必须留下来看着，这样被传递的是技能，而不只是把产品修好。

批评者指出，这场运动无法抵消电子垃圾的规模——2022 年全球电子垃圾达 6200 万吨。然而咖啡馆能做到回收工厂做不到的事：改变一个人脑中的算计。一旦你见过电水壶的内部，把它扔掉就不再像丢弃垃圾，而更像是一种放弃。`,
    vocab: [
      { term: 'appliance', reading: '/əˈplaɪəns/', pos: 'n.', meaning: '家用电器；器具', example: 'Kitchen appliances account for much of household waste.' },
      { term: 'frustrated', reading: '/ˈfrʌstreɪtɪd/', pos: 'adj.', meaning: '沮丧的；受挫的', example: 'She was frustrated by the constant delays.' },
      { term: 'mend', reading: '/mend/', pos: 'v.', meaning: '修理；修补', example: 'He mended the chair with a strip of glue.' },
      { term: 'appeal', reading: '/əˈpiːl/', pos: 'n.', meaning: '吸引力', example: 'The appeal of the scheme lies in its simplicity.' },
      { term: 'donation', reading: '/doʊˈneɪʃn/', pos: 'n.', meaning: '捐款；捐赠', example: 'Visitors may leave a small donation.' },
      { term: 'transfer', reading: '/trænsˈfɜːr/', pos: 'v.', meaning: '传递；转移', example: 'The training transfers skills to local staff.' },
      { term: 'offset', reading: '/ˌɔːfˈset/', pos: 'v.', meaning: '抵消；弥补', example: 'Tree planting cannot offset all emissions.' },
      { term: 'volume', reading: '/ˈvɑːljuːm/', pos: 'n.', meaning: '总量；体积', example: 'The volume of waste keeps rising.' },
      { term: 'discard', reading: '/dɪsˈkɑːrd/', pos: 'v.', meaning: '丢弃', example: 'Consumers discard millions of phones each year.' },
      { term: 'calculation', reading: '/ˌkælkjuˈleɪʃn/', pos: 'n.', meaning: '计算；算计', example: 'Repairing changed the calculation in her head.' },
    ],
    questions: [
      {
        prompt: 'What was unusual about the rule described in paragraph 2?',
        options: [
          'Owners had to pay for spare parts in advance.',
          'Owners had to remain and watch the repair.',
          'Only professional engineers could take part.',
          'Objects had to be collected within a week.',
        ],
        answer: 1,
        explain: '原文：owners must stay and watch, so that the skill is transferred rather than the product merely fixed。',
      },
      {
        prompt: 'The phrase "change the calculation in a person\'s head" suggests that repair cafés',
        options: [
          'help people compare prices more accurately',
          'alter how people judge whether to keep or throw away an object',
          'teach basic mathematics to volunteers',
          'reduce the cost of household appliances',
        ],
        answer: 1,
        explain: '后一句"见过电水壶内部后，扔掉更像一种放弃"说明改变的是价值判断，而非价格计算。',
      },
      {
        prompt: 'Which statement best reflects the critics\' view?',
        options: [
          'Repair cafés are too expensive to run.',
          'The movement is too small to affect total e-waste.',
          'Volunteers lack the skills to repair modern devices.',
          'Recycling plants are more socially valuable.',
        ],
        answer: 1,
        explain: 'cannot offset the volume of electronic waste，即规模不足以抵消总量。',
      },
    ],
    readingScript: {
      segments: [
        {
          text: 'The first Repair Café opened in Amsterdam in 2009, in a small theatre hall rented for a few hours on a Saturday.',
          translation: '第一家"修理咖啡馆"于 2009 年在阿姆斯特丹开张，场地是周六租用几个小时的小剧场。',
          tips: ['Repair Café 为专有名词，重读', 'rented for a few hours 为后置定语，语速可加快'],
        },
        {
          text: 'What they cannot do is drop off an object and collect it later; the rule is that owners must stay and watch, so that the skill is transferred rather than the product merely fixed.',
          translation: '他们唯一不能做的是"把东西放下、日后来取"——规矩是物主必须留下来看着，这样被传递的是技能，而不只是把产品修好。',
          tips: ['分号处停顿', 'rather than 前后形成对比，重音落在 skill 与 product'],
        },
      ],
    },
  },
];
