import type { SeedPool } from './types';

/**
 * 英语题库池（托福 iBT 分项：Listening / Vocabulary / Reading / Writing）。
 *
 * 说明：按 iBT 题型与难度编写，不是原卷影印；卷子按年份从池中轮换组合。
 * 托福本身没有独立的语法分项，grammar 留空，导入真卷时仍可写入。
 */
export const EN_POOL: SeedPool = {
  language: 'en',
  examName: '托福 iBT',
  levelLabel: '冲 100',
  plan: [
    { key: 'listening', label: 'Listening', take: 2, minutes: 6 },
    { key: 'vocab', label: 'Vocabulary', take: 2, minutes: 3 },
    { key: 'reading', label: 'Reading', take: 1, minutes: 9 },
    { key: 'writing', label: 'Writing', take: 1, minutes: 10 },
  ],
  listening: [
    {
      section: 'listening',
      label: 'Conversation',
      audioText:
        'Student: Professor, do you have a minute? I wanted to ask about the lab report that’s due Friday.\nProfessor: Sure. Is something unclear?\nStudent: It’s the data set. I ran the trial three times, but the second run gave me values that are way off the others. I don’t know whether to include it or drop it.\nProfessor: Don’t drop it. Actually, that’s the interesting part. Did you note the room temperature during that run?\nStudent: Not exactly. I know it was late afternoon, and the air conditioning had been on all day.\nProfessor: Then write it up as an anomaly and explain the likely cause. Reports that hide inconvenient numbers are less useful than ones that explain them.',
      stem: 'What does the professor suggest the student do with the unusual data?',
      options: [
        'Repeat the entire experiment from the beginning',
        'Remove it so that the averages stay consistent',
        'Keep it and explain the probable cause of the deviation',
        'Ask another student to check the calculations',
      ],
      answer: 2,
      explanation:
        '“Don’t drop it… write it up as an anomaly and explain the likely cause” 明确要求保留异常值并解释原因。A 未提及重做，B 与教授意见相反，D 属无中生有。',
    },
    {
      section: 'listening',
      label: 'Lecture',
      audioText:
        'Lecturer: We tend to assume that a city grows because people arrive. But look at nineteenth-century Manchester: the population tripled in fifty years, and yet the death rate was higher than in the surrounding countryside. So growth was not simply a matter of attraction. What pulled people in was employment, and what pushed them out of villages was enclosure of common land. In other words, migration is usually a two-sided story — a pull and a push — and the push is often the stronger of the two.',
      stem: 'What is the main point of the lecture?',
      options: [
        'Urban growth in the nineteenth century was caused mainly by better living conditions.',
        'Migration is best explained by a combination of pull and push factors.',
        'Manchester’s population grew more slowly than historians once believed.',
        'Enclosure of common land had little effect on village populations.',
      ],
      answer: 1,
      explanation:
        '“migration is usually a two-sided story — a pull and a push” 是主旨句。A 与“death rate was higher”矛盾，C 与“tripled”矛盾，D 与“what pushed them out… was enclosure”矛盾。',
    },
    {
      section: 'listening',
      label: 'Conversation',
      audioText:
        'Librarian: You’re returning the course reserve book two days late, so there’s a fine.\nStudent: I know, I’m sorry. The thing is, my roommate took it to a seminar in another building and I only got it back this morning.\nLibrarian: I can waive the fine once per term if the book comes back in good condition. Let me check… it looks fine. I’ll clear it.\nStudent: Thank you. Should I still pay something?\nLibrarian: No. But from now on, keep reserve books in the library — they’re not supposed to leave the building at all.',
      stem: 'What will the librarian do?',
      options: [
        'Charge the student the full fine',
        'Waive the fine but warn the student about the lending rule',
        'Ask the roommate to pay the fine instead',
        'Refuse to accept the returned book',
      ],
      answer: 1,
      explanation:
        '“I can waive the fine once per term… I’ll clear it” 加上末尾“keep reserve books in the library… not supposed to leave the building”，即免罚但提醒规则。',
    },
    {
      section: 'listening',
      label: 'Lecture',
      audioText:
        'Lecturer: Plants cannot run away, so they negotiate chemically. When a caterpillar starts feeding, the leaf releases a compound that travels through the air and attracts parasitic wasps — insects that lay their eggs inside the caterpillar. The plant is, in effect, recruiting a bodyguard. What’s remarkable is that this response is not generic: the blend of chemicals differs depending on which species is feeding.',
      stem: 'Why does the professor mention that the chemical blend differs by species?',
      options: [
        'To show that the plant’s defense is specific rather than general',
        'To explain why caterpillars prefer certain leaves',
        'To suggest that wasps cannot distinguish among plants',
        'To argue that chemical signaling is a recent discovery',
      ],
      answer: 0,
      explanation:
        '“this response is not generic: the blend differs depending on which species is feeding” 的目的是强调防御具有针对性，即 specific 而非 general。',
    },
    {
      section: 'listening',
      label: 'Conversation',
      audioText:
        'Advisor: You’ve chosen four courses, and two of them meet at the same time on Thursday.\nStudent: Oh no. I didn’t notice. The statistics lab is the one I really need this term, because it’s only offered in the fall.\nAdvisor: Then keep the lab and move the other one. There’s an evening section of the literature course that still has seats.\nStudent: Is the evening section taught by the same professor?\nAdvisor: No, but the syllabus and the exams are shared across sections, so it won’t affect your transcript.',
      stem: 'What does the advisor recommend?',
      options: [
        'Dropping the statistics lab until next year',
        'Taking the literature course in its evening section',
        'Changing both courses to a different term',
        'Asking the professor to reschedule the lab',
      ],
      answer: 1,
      explanation:
        '“keep the lab and move the other one… an evening section of the literature course” 即保留统计实验课、把文学课换到晚上班。',
    },
  ],
  vocab: [
    {
      section: 'vocab',
      label: 'Vocabulary',
      stem: 'The word “**rudimentary**” in the sentence below is closest in meaning to:\n“Early maps were rudimentary: coastlines were sketched from memory, and distances were often wildly wrong.”',
      options: ['highly accurate', 'basic and undeveloped', 'carefully measured', 'widely copied'],
      answer: 1,
      explanation:
        'rudimentary = 初步的、粗糙的，与 basic/undeveloped 最近。后文“sketched from memory… distances wildly wrong”也在提示其不成熟。accurate、measured 与之相反。',
    },
    {
      section: 'vocab',
      label: 'Vocabulary',
      stem: 'The word “**mitigate**” in the sentence below is closest in meaning to:\n“Planting trees along the riverbank can mitigate flooding by slowing the runoff that reaches the channel.”',
      options: ['predict', 'lessen', 'measure', 'cause'],
      answer: 1,
      explanation:
        'mitigate = 减轻、缓和，与 lessen 对应。“slowing the runoff”正是减轻洪水的方式。predict（预测）、measure（测量）、cause（导致）都不合。',
    },
    {
      section: 'vocab',
      label: 'Vocabulary',
      stem: 'The word “**tenuous**” in the sentence below is closest in meaning to:\n“The link between the two fossils is tenuous: only a single fragment of jaw supports the claim.”',
      options: ['weak', 'recent', 'obvious', 'deliberate'],
      answer: 0,
      explanation:
        'tenuous = 薄弱的、站不住脚的。冒号后的“only a single fragment”是解释，说明证据不足，故为 weak。',
    },
    {
      section: 'vocab',
      label: 'Vocabulary',
      stem: 'The word “**ubiquitous**” in the sentence below is closest in meaning to:\n“By the 1920s, radio was ubiquitous in American households, as ordinary as a kitchen table.”',
      options: ['rarely used', 'expensive', 'found everywhere', 'strictly regulated'],
      answer: 2,
      explanation:
        'ubiquitous = 无处不在。“as ordinary as a kitchen table”是同位解释，故为 found everywhere。',
    },
    {
      section: 'vocab',
      label: 'Vocabulary',
      stem: 'The word “**precipitate**” in the sentence below is closest in meaning to:\n“A sudden drop in temperature can precipitate a collapse of the entire food web in a shallow lake.”',
      options: ['prevent', 'trigger', 'delay', 'reverse'],
      answer: 1,
      explanation:
        'precipitate 作动词意为“促使（某事）突然发生”，与 trigger 对应。prevent、delay、reverse 与“collapse”发生的方向不符。',
    },
    {
      section: 'vocab',
      label: 'Vocabulary',
      stem: 'The word “**nominal**” in the sentence below is closest in meaning to:\n“The committee retained its authority in name only; in practice its role was nominal.”',
      options: ['in name only', 'considerable', 'disputed', 'temporary'],
      answer: 0,
      explanation:
        'nominal = 名义上的，与“in name only”同义，句中已直接把意思说出来了。considerable 相反，disputed/temporary 不是词义。',
    },
  ],
  grammar: [],
  reading: [
    {
      passage:
        'The invention of the mechanical clock in fourteenth-century Europe did more than measure time; it reorganized the day itself. Before clocks, work began when light allowed and ended when it failed. Monastic communities had long divided the day into prayer hours, but those hours stretched in summer and shrank in winter. Mechanical clocks, by contrast, divided the day into equal units regardless of the season.\n\nThat equality had social consequences. Once hours were equal, an hour of labor could be bought, sold, and compared — a precondition for wage work as we know it. Town councils that paid for a public clock were not simply buying a convenience; they were announcing that the town’s time would no longer be the church’s time alone. Historians who treat the clock as a merely technical achievement miss this. The device did not just keep time better; it changed what time was for.',
      label: 'History',
      items: [
        {
          label: 'Rhetorical purpose',
          stem: 'Why does the author mention monastic communities?',
          options: [
            'To argue that the church opposed the spread of clocks',
            'To show that earlier timekeeping divided the day unequally',
            'To explain who built the first mechanical clocks',
            'To suggest that monks were the first wage laborers',
          ],
          answer: 1,
          explanation:
            '第一段说修道院的祈祷时刻“stretch in summer and shrink in winter”，与机械钟的等长时段形成对比，作用是说明此前的时间划分并不等长。',
        },
        {
          label: 'Inference',
          stem: 'What can be inferred from the passage about town councils that funded public clocks?',
          options: [
            'They wanted to reduce the power of the church over daily schedules.',
            'They expected the clocks to improve navigation.',
            'They were required to do so by royal decree.',
            'They intended the clocks for religious use only.',
          ],
          answer: 0,
          explanation:
            '“the town’s time would no longer be the church’s time alone”说明市议会借公共钟宣示对时间的支配，可推知意在削弱教会对日常作息的支配。',
        },
      ],
    },
    {
      passage:
        'Coral reefs cover less than one percent of the ocean floor, yet they shelter roughly a quarter of all marine species. Their productivity depends less on the nutrient content of the surrounding water than on the tight recycling of nutrients within the reef community. Algae living inside coral tissues capture sunlight and pass sugars to their hosts; in return, the coral provides shelter and waste products that the algae reuse.\n\nThis partnership is fragile. When water temperatures rise by even one or two degrees for several weeks, the algae leave, and the coral loses both its color and its main food source — a process called bleaching. The reef does not die immediately; it can recover if conditions return to normal within a few weeks. But repeated bleaching events shorten that window, because each episode leaves the coral with less energy to rebuild.',
      label: 'Biology',
      items: [
        {
          label: 'Factual information',
          stem: 'According to the passage, the high productivity of coral reefs is mainly due to',
          options: [
            'the nutrient-rich water surrounding them',
            'the large area of ocean floor they cover',
            'the efficient recycling of nutrients within the reef',
            'the migration of species through the reef',
          ],
          answer: 2,
          explanation:
            '“depends less on the nutrient content of the surrounding water than on the tight recycling of nutrients within the reef community” 明确把重心放在礁体内部循环。A 恰是被否定的那一项。',
        },
        {
          label: 'Negative fact',
          stem: 'All of the following are mentioned as effects of bleaching EXCEPT',
          options: [
            'the coral loses its color',
            'the coral loses its main food source',
            'the coral dies immediately',
            'the coral has less energy to rebuild',
          ],
          answer: 2,
          explanation:
            '原文说“The reef does not die immediately; it can recover…”，即不会立刻死亡，故 C 与原文相反，为否定事实题的答案。',
        },
      ],
    },
    {
      passage:
        'Economists once described the firm as a machine for allocating resources: inputs go in, outputs come out, and the manager’s job is to keep the ratios right. That metaphor is tidy but it hides the hardest part of the job. Most of what a manager decides cannot be written down in advance — who should talk to whom, which delay is worth tolerating, when a rule should be broken.\n\nA more accurate image may be the garden. A gardener does not manufacture growth; she arranges conditions — light, water, spacing — under which growth becomes likely. The work is indirect, and its results arrive late. Judged by the standards of the machine metaphor, such a manager looks idle. Judged by outcomes over several years, she is usually the reason anything grew at all.',
      label: 'Social science',
      items: [
        {
          label: 'Sentence simplification',
          stem: 'Which of the following best expresses the essential information in: “Most of what a manager decides cannot be written down in advance — who should talk to whom, which delay is worth tolerating, when a rule should be broken.”',
          options: [
            'Managers spend most of their time writing rules for others to follow.',
            'Many managerial decisions depend on judgment that cannot be specified beforehand.',
            'Managers should avoid tolerating delays whenever possible.',
            'Most decisions a manager makes can be predicted from company policy.',
          ],
          answer: 1,
          explanation:
            '原句核心是“多数管理决策无法事先写下来（规则化）”，即依赖临场判断。B 保留这层意思；A、D 与原句相反，C 只是举例中的一项。',
        },
        {
          label: 'Author’s attitude',
          stem: 'The author’s attitude toward the “machine” metaphor is best described as',
          options: ['enthusiastic', 'critical but not dismissive', 'completely indifferent', 'hostile and sarcastic'],
          answer: 1,
          explanation:
            '作者称该比喻“tidy but it hides the hardest part”，既承认其清晰（tidy），又指出其遗漏，属于有保留的批评，而非全盘否定。',
        },
      ],
    },
  ],
  writing: [
    {
      section: 'writing',
      kind: 'writing',
      label: 'Writing',
      stem:
        'Do you agree or disagree with the following statement?\n\n“Universities should require every student to take at least one course outside their major field.”\n\nWrite an essay of about 250–300 words. Use specific reasons and examples to support your answer.',
      minWords: 200,
      explanation:
        '评分观察点：①立场在第一段明确 ②两段论证各有具体例子（不必多，但要具体）③承认对方观点并回应 ④句式有变化、少用模板套话。',
      sampleAnswer:
        'I agree that every student should take at least one course outside their major, though I would stop short of requiring several.\n\nMy main reason is that most real problems are not organized by discipline. A friend of mine studied structural engineering and spent a term in a course on environmental policy. Two years later, on her first job, she was the only engineer in the room who could explain why a cheaper design would fail a permitting review. The course did not make her a policy expert; it gave her a second language for talking to the people who approved her work.\n\nA second reason is that students often discover what they actually want to do only by accident. A single elective is a cheap way to test a hypothesis about yourself. The cost of one course is small compared with the cost of discovering, at thirty, that the field you trained for is not the one you can spend a life in.\n\nCritics will say that electives dilute rigor, and there is something to that. But a requirement of one course is unlikely to crowd out a major; students already fill their schedules with courses of uneven value. The real risk is not breadth but a curriculum so narrow that graduates can talk only to people who already agree with them.\n\nFor these reasons, a single outside course is a modest requirement with an outsized return.',
    },
    {
      section: 'writing',
      kind: 'writing',
      label: 'Writing',
      stem:
        'Some people believe that working from home improves productivity; others argue that it weakens collaboration. Which view do you find more convincing?\n\nWrite an essay of about 250–300 words, using specific examples.',
      minWords: 200,
      explanation:
        '评分观察点：①明确选边，而不是两边都说好 ②用具体场景（会议、交接、新人上手）支撑 ③对反方给出可回应的让步 ④段落之间有推进，不是并列三点。',
      sampleAnswer:
        'For most knowledge work, I find the collaboration argument more convincing — not because remote work is inefficient, but because its costs fall unevenly and quietly.\n\nFocused tasks clearly benefit from distance. Writing, coding, and analysis improve when interruptions disappear, and many people report doing in four hours what once took six. If productivity meant only output per hour of attention, the case would be closed.\n\nBut the work that suffers is the work nobody schedules. When a junior colleague is stuck, proximity turns a five-minute question into a decision not to ask. When a project changes direction, the hallway conversation that would have prevented three days of wasted effort simply never happens. These losses do not appear in any dashboard; they appear six months later as a missed deadline or a person who quietly leaves.\n\nA fair objection is that offices also generate waste — commutes, noise, performative presence. That is true, and it is why the answer is not a full return. The workable compromise is deliberate: two or three shared days for the ambiguous work of deciding and teaching, and protected blocks of solitude for the work of producing. What fails is neither home nor office, but the assumption that one setting can serve both.',
    },
    {
      section: 'writing',
      kind: 'writing',
      label: 'Writing',
      stem:
        'Summarise the lecture you just heard and explain how it relates to the reading passage on the same topic.\n\n(Topic: whether early cities were healthier than rural areas.)\n\nWrite about 150–225 words.',
      minWords: 120,
      explanation:
        '综合写作的要点：①不复述阅读，只点出其三个论点 ②逐条对应讲座的反驳 ③不加入自己的观点 ④用“the lecturer argues that…”这类转述句式。',
      sampleAnswer:
        'The reading claims that early cities were unhealthier than the countryside, citing crowded housing, contaminated water, and the rapid spread of disease. The lecturer accepts the crowding but argues that the comparison is misleading in three ways.\n\nFirst, the reading treats density as proof of disease, yet the lecturer notes that rural areas suffered epidemics carried by livestock, which cities did not keep in the same numbers. Second, on water: the lecture points out that many cities built aqueducts earlier than the reading assumes, so contaminated supply was a problem of specific periods rather than of urban life as such. Third, the reading measures health by average lifespan, which the lecturer says is distorted by high infant mortality among recent migrants; among adults who survived to twenty, urban and rural lifespans were nearly equal.\n\nThus the lecture does not deny that early cities were dangerous places, but it argues that the evidence used to rank them below the countryside is weaker than it appears.',
    },
  ],
};
