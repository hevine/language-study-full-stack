import type { ArticlePayload } from '../domain/types';

/**
 * 演示模式内置精读库 · 扩充篇（与 library.en.ts 合并后按天轮换）。
 * 配置大模型后仍会优先按当日考纲实时生成，本库仅作为无模型时的回退。
 */
export const EN_LIBRARY_EXTRA: ArticlePayload[] = [
  {
    title: 'The Hidden Value of Urban Green Space',
    body: `City planners once treated parks as decoration — pleasant, but secondary to roads, housing and offices. A growing body of economic research now argues the opposite: green space is infrastructure, and it pays for itself. Properties facing a well-maintained park in Chicago sold for roughly twenty percent more than comparable buildings a block away, and the resulting property taxes can exceed the park's annual upkeep within a few years.

The benefits reach beyond real estate. Trees filter fine particulates from vehicle exhaust, and a single mature canopy can cool a street by several degrees during a heat wave, reducing the demand for air conditioning. Public health data point the same way: residents of greener neighborhoods report lower levels of stress hormones and visit clinics less often for anxiety-related complaints.

Critics note that greening can backfire. When a neglected district becomes desirable, rents climb and long-term tenants are pushed out — a process researchers call green gentrification. The policy challenge, therefore, is not whether to plant trees but how to spread the gains fairly: pairing new parks with affordable-housing guarantees, and directing maintenance budgets to the neighborhoods that need cooling most.`,
    translation: `城市规划者曾把公园当作装饰——令人愉快，但排在道路、住宅和办公楼之后。越来越多经济学研究提出相反的观点：绿地是基础设施，而且能自己回本。在芝加哥，面对养护良好的公园的房产，比一个街区外类似的建筑贵出约百分之二十，由此产生的房产税几年内就能超过公园每年的维护费用。

好处还不止房地产。树木能过滤汽车尾气中的细颗粒物，在热浪期间，一片成熟树冠可以让街道降温数度，减少空调需求。公共健康数据也指向同一方向：绿化更好街区的居民，压力激素水平更低，因焦虑相关不适去诊所就诊的次数也更少。

批评者指出，绿化可能适得其反。当一片被忽视的城区变得抢手，租金上涨，长期租户被挤走——研究者称之为"绿色士绅化"。因此政策的难点不在于种不种树，而在于如何公平地分配收益：为新公园配套保障性住房承诺，并把养护预算投向最需要降温的社区。`,
    vocab: [
      { term: 'infrastructure', reading: '/ˈɪnfrəstrʌktʃər/', pos: 'n.', meaning: '基础设施', example: 'Green space should be treated as infrastructure.' },
      { term: 'comparable', reading: '/ˈkɑːmpərəbl/', pos: 'adj.', meaning: '可比较的；类似的', example: 'Comparable buildings a block away sold for less.' },
      { term: 'upkeep', reading: '/ˈʌpkiːp/', pos: 'n.', meaning: '维护（费）', example: 'Property taxes can exceed the park\u0027s annual upkeep.' },
      { term: 'particulate', reading: '/pɑːrˈtɪkjələt/', pos: 'n.', meaning: '颗粒物', example: 'Trees filter fine particulates from exhaust.' },
      { term: 'canopy', reading: '/ˈkænəpi/', pos: 'n.', meaning: '树冠；顶篷', example: 'A mature canopy can cool a street.' },
      { term: 'complaint', reading: '/kəmˈpleɪnt/', pos: 'n.', meaning: '不适；投诉', example: 'Clinics see fewer anxiety-related complaints.' },
      { term: 'backfire', reading: '/ˈbækfaɪər/', pos: 'v.', meaning: '适得其反', example: 'Greening can backfire in hot markets.' },
      { term: 'desirable', reading: '/dɪˈzaɪərəbl/', pos: 'adj.', meaning: '抢手的；令人向往的', example: 'The district became desirable within a decade.' },
      { term: 'tenant', reading: '/ˈtenənt/', pos: 'n.', meaning: '租户', example: 'Long-term tenants are pushed out.' },
      { term: 'guarantee', reading: '/ˌɡærənˈtiː/', pos: 'n./v.', meaning: '保证；承诺', example: 'Pair new parks with affordable-housing guarantees.' },
    ],
    questions: [
      {
        prompt: 'What is the central argument of the passage?',
        options: [
          'Parks are too expensive for most cities to maintain',
          'Urban green space functions as infrastructure with measurable economic returns',
          'Property taxes should be reduced near parks',
          'Tree planting is the main cause of rising rents',
        ],
        answer: 1,
        explain: '首段提出核心论点「绿地是基础设施且能回本」，后文用房价、健康数据与分配难题支撑。',
      },
      {
        prompt: 'The Chicago example is used mainly to illustrate that',
        options: [
          'parks increase nearby property values enough to offset their cost',
          'Chicago has more parks than other cities',
          'park maintenance is unpredictable',
          'buyers prefer new buildings near parks',
        ],
        answer: 0,
        explain: '例子的落点是「房产税几年内即可覆盖维护费」，即经济上自偿。',
      },
      {
        prompt: 'According to the passage, green gentrification refers to',
        options: [
          'the use of green building materials',
          'rising rents that displace residents after a neighborhood is greened',
          'government subsidies for parks',
          'conflicts between developers and planners',
        ],
        answer: 1,
        explain: '第三段明确给出定义：城区变抢手→租金上涨→长期租户被挤走。',
      },
    ],
    readingScript: {
      segments: [
        { text: 'City planners once treated parks as decoration — pleasant, but secondary to roads, housing and offices.', translation: '城市规划者曾把公园当作装饰——令人愉快，但排在道路、住宅和办公楼之后。', tips: ['破折号处停半拍，"secondary to" 轻读带过'] },
        { text: 'A growing body of economic research now argues the opposite: green space is infrastructure, and it pays for itself.', translation: '越来越多经济学研究提出相反的观点：绿地是基础设施，而且能自己回本。', tips: ['"argues the opposite" 是转折核心，重读'] },
        { text: 'Properties facing a well-maintained park in Chicago sold for roughly twenty percent more than comparable buildings a block away.', translation: '在芝加哥，面对养护良好公园的房产，比一个街区外类似建筑贵约百分之二十。', tips: ['数字 twenty percent 放慢读清'] },
        { text: 'The benefits reach beyond real estate. Trees filter fine particulates from vehicle exhaust, and a single mature canopy can cool a street by several degrees during a heat wave.', translation: '好处还不止房地产。树木能过滤尾气细颗粒物，热浪期间成片树冠能给街道降温数度。', tips: ['"reach beyond" 略上扬引出下文'] },
        { text: 'Critics note that greening can backfire. When a neglected district becomes desirable, rents climb and long-term tenants are pushed out — a process researchers call green gentrification.', translation: '批评者指出绿化可能适得其反：城区变抢手后租金上涨，长期租户被挤走——研究者称之为绿色士绅化。', tips: ['"backfire" 与 "pushed out" 都要读出否定意味'] },
        { text: 'The policy challenge, therefore, is not whether to plant trees but how to spread the gains fairly.', translation: '因此政策的难点不在于种不种树，而在于如何公平地分配收益。', tips: ['"not... but..." 对比结构，前轻后重'] },
      ],
    },
  },
  {
    title: 'Why Languages Borrow Words',
    body: `Purists have complained about loanwords for centuries. In the seventeenth century, English critics sneered at the flood of French terms pouring in after the Norman conquest had long faded; today, the same anxiety greets borrowed tech vocabulary. Yet borrowing is not a sign of decay. It is one of the most ordinary things a language can do, and the historical record shows that languages absorb foreign words precisely when they are healthy, expanding their trade, science and culture.

The mechanics are simple. When two communities trade, fight or intermarry, speakers reach for the handiest word, and the handy word is usually the neighbor's. English took "skirt" from Norse and "shirt" from its own Germanic stock — both from the same ancestral root — because Norse speakers dominated northern England long enough for their pronunciation to stick. Borrowed words also tend to occupy specialized niches: restaurant menus are French, classical music is Italian, and academic prose leans on Latin precisely because those were the prestige domains.

What actually threatens a language is not borrowing but the retreat of its domains. A language that loses its schools, courts and broadcasts will fade no matter how pure its vocabulary. Icelandic speakers, by contrast, coin new native words for every innovation and still watch films, run universities and raise children in Icelandic — proof that vigilance, not purity, is what keeps a language alive.`,
    translation: `几个世纪以来，纯粹主义者一直在抱怨外来词。十七世纪，英国批评家讥讽诺曼征服后涌入的大量法语词——尽管征服早已远去；今天，同样的焦虑又落在了借入的科技词汇上。然而借词并不是语言衰败的征兆。它是一门语言最寻常的行为之一，历史记录表明：语言恰恰在健康、扩张贸易、科学与文化的时期大量吸收外来词。

机制很简单。当两个社群贸易、交战或通婚时，说话人会挑最顺手的词，而顺手的词往往是邻居的。英语从古诺斯语借来 "skirt"，又从本族日耳曼语保留了 "shirt"——两者同源——因为诺斯使用者统治英格兰北部足够久，他们的发音就留了下来。借词还倾向于占据专门领域：餐厅菜单是法语的，古典音乐术语是意大利语的，学术文体依赖拉丁语，正因为这些曾是"高级"领域。

真正威胁一门语言的不是借词，而是使用领域的萎缩。一门语言一旦失去学校、法庭和广播，无论词汇多么"纯正"都会消亡。相反，冰岛语使用者坚持为每个新事物造本族新词，同时照样看电影、办大学、用冰岛语养育孩子——这说明让语言活下来的是守护，而不是纯粹。`,
    vocab: [
      { term: 'purist', reading: '/ˈpjʊrɪst/', pos: 'n.', meaning: '纯粹主义者', example: 'Purists have complained about loanwords for centuries.' },
      { term: 'sneer at', reading: '/snɪər/', pos: 'v.', meaning: '讥讽；嘲笑', example: 'Critics sneered at the flood of French terms.' },
      { term: 'decay', reading: '/dɪˈkeɪ/', pos: 'n.', meaning: '衰败；腐朽', example: 'Borrowing is not a sign of decay.' },
      { term: 'absorb', reading: '/əbˈzɔːrb/', pos: 'v.', meaning: '吸收', example: 'Languages absorb foreign words when they are healthy.' },
      { term: 'intermarry', reading: '/ˌɪntərˈmæri/', pos: 'v.', meaning: '通婚', example: 'Communities trade, fight or intermarry.' },
      { term: 'ancestral', reading: '/ænˈsestrəl/', pos: 'adj.', meaning: '祖先的；同源的', example: 'Both words share an ancestral root.' },
      { term: 'niche', reading: '/niːʃ/', pos: 'n.', meaning: '细分领域；生态位', example: 'Borrowed words occupy specialized niches.' },
      { term: 'prestige', reading: '/preˈstiːʒ/', pos: 'n.', meaning: '威望；声望', example: 'Those were the prestige domains.' },
      { term: 'retreat', reading: '/rɪˈtriːt/', pos: 'n.', meaning: '退缩；萎缩', example: 'The retreat of its domains is the real threat.' },
      { term: 'vigilance', reading: '/ˈvɪdʒɪləns/', pos: 'n.', meaning: '警惕；守护', example: 'Vigilance, not purity, keeps a language alive.' },
    ],
    questions: [
      {
        prompt: 'The author\u0027s main point about borrowing is that it',
        options: [
          'weakens a language over time',
          'is a normal sign of a language\u0027s vitality',
          'happens only through conquest',
          'should be limited by language academies',
        ],
        answer: 1,
        explain: '第一段提出观点：借词是语言"最寻常的行为"，恰恰发生在语言健康的时期。',
      },
      {
        prompt: 'The skirt/shirt example illustrates that borrowed words',
        options: [
          'usually replace native words entirely',
          'can coexist with native words from the same root',
          'are harder to pronounce',
          'enter a language only through trade',
        ],
        answer: 1,
        explain: '两词同源却并存，说明借词与本族词可以长期共处。',
      },
      {
        prompt: 'The Icelandic case is presented to show that',
        options: [
          'isolated languages never change',
          'purity alone cannot preserve a language',
          'coining new words is useless',
          'films endanger minority languages',
        ],
        answer: 1,
        explain: '结尾强调：起作用的是 vigilance（守护），不是 purity（纯粹）。',
      },
    ],
    readingScript: {
      segments: [
        { text: 'Purists have complained about loanwords for centuries.', translation: '几个世纪以来，纯粹主义者一直在抱怨外来词。', tips: ['开头句放稳，"for centuries" 拖长收尾'] },
        { text: 'Yet borrowing is not a sign of decay. It is one of the most ordinary things a language can do, and the historical record shows that languages absorb foreign words precisely when they are healthy.', translation: '然而借词并不是衰败的征兆。它是一门语言最寻常的行为之一，历史表明语言恰恰在健康时期大量吸收外来词。', tips: ['"Yet" 转折提高音量，"precisely" 重读'] },
        { text: 'When two communities trade, fight or intermarry, speakers reach for the handiest word, and the handy word is usually the neighbor\u0027s.', translation: '当两个社群贸易、交战或通婚时，说话人会挑最顺手的词，而顺手的词往往是邻居的。', tips: ['三连动词 trade/fight/intermarry 节奏均匀'] },
        { text: 'Borrowed words also tend to occupy specialized niches: restaurant menus are French, classical music is Italian, and academic prose leans on Latin.', translation: '借词还倾向于占据专门领域：餐厅菜单是法语的，古典音乐术语是意大利语的，学术文体依赖拉丁语。', tips: ['冒号后三个例子逐个清晰读出'] },
        { text: 'What actually threatens a language is not borrowing but the retreat of its domains.', translation: '真正威胁一门语言的不是借词，而是使用领域的萎缩。', tips: ['"not... but..." 对比，重音落在 retreat'] },
        { text: 'Vigilance, not purity, is what keeps a language alive.', translation: '让语言活下来的是守护，而不是纯粹。', tips: ['结尾句放慢，两个核心词都重读'] },
      ],
    },
  },
];
