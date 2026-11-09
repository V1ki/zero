export type AssetKind = 'character' | 'location' | 'prop'

export type StoryChapter = {
  id: string
  number: number
  title: string
  summary: string
  paragraphs: string[]
  sourceLabel: string
}

export type StudioAsset = {
  id: string
  kind: AssetKind
  name: string
  subtitle: string
  version: string
  status: 'locked' | 'review'
  description: string
  sourceQuote: string
  features: string[]
  accent: string
}

export type StudioShot = {
  id: string
  sequence: number
  title: string
  chapterId: string
  sourceText: string
  action: string
  camera: string
  durationSec: number
  assetIds: string[]
  prompt: string
  negativePrompt: string
  status: 'draft' | 'ready' | 'generated'
}

export type GenerationTask = {
  id: string
  shotId: string
  type: 'image' | 'video'
  provider: string
  model: string
  status: 'queued' | 'running' | 'succeeded' | 'failed'
  createdAt: string
  completedAt?: string
  requestSummary: string
  assetVersions: string[]
  prompt: string
  resultUrl?: string
  errorMessage?: string
}

export const DEFAULT_CHAPTERS: StoryChapter[] = [
  {
    id: 'chapter-1',
    number: 1,
    title: '堵床底下了',
    summary: '陈实在甜水巷喂马时，撞见泽二爷私会外室。萧凤箫带人封住院门，陈实被迫替主子解围。',
    sourceLabel: 'Demo 完整示例 · 从骑奴到大乾武圣 · 第 1 章',
    paragraphs: [
      '甜水巷一座独门小院，陈实蹲在卧房窗户下面，拿根树枝拨弄地上的蚂蚁玩。渐渐地，里面传来一男一女的声音。',
      '陈实原本也是安居之家，奈何父亲不争气，被人做局输光产业。父亲投河自尽后，母亲将他卖进靖安侯府，成为一名身份低下的骑奴。',
      '“二奶奶，就是那座院子！”巷口传来一阵吆喝。泽二奶奶带着一群奴仆快步走来，要把这座院子前后堵住。',
      '陈实连忙跑回院子，刚闯进屋子便大喊：“不好了二爷！二奶奶来了！”顾承泽慌乱找衣服，外面已经传来砸门的声音。',
      '“你！到床上去！”顾承泽环顾四周，直接钻进了床底。陈实僵在原地，听着院门终于被撞开。',
    ],
  },
  {
    id: 'chapter-2',
    number: 2,
    title: '差事',
    summary: '萧凤箫将计就计，逼陈实和翠浓演戏。顾承泽借机许诺调职，又交给陈实一件危险差事。',
    sourceLabel: 'Demo 示例 · 从骑奴到大乾武圣 · 第 2 章',
    paragraphs: [
      '萧凤箫没有当场揭穿顾承泽，而是借着侯府的体面，把惩治变成一场公开的敲打。',
      '她准陈实两个月假，每日来与翠浓温存，又命人挨家挨户通知，说这女人和侯府骑奴相好。',
      '顾承泽从床底爬出后，非但没有责罚陈实，反而赏了一块碎银，又答应日后将他调到自己院里听用。',
      '“你过来之后，需得给我做好一件差事。”顾承泽压低声音，“我不管你用什么法子，待你过来之后，必须搞定萧凤箫！”',
    ],
  },
  {
    id: 'chapter-3',
    number: 3,
    title: '上锁了',
    summary: '陈实在日落前赶回侯府，角门将闭。甜水巷留下的风波，开始沿着侯府的规矩继续发酵。',
    sourceLabel: 'Demo 示例 · 从骑奴到大乾武圣 · 第 3 章',
    paragraphs: [
      '不知不觉，日头已经西沉，陈实从床上爬下来，低着头向翠浓告辞。',
      '翠浓望着房梁失神。她好不容易被顾承泽赎身，原以为可以进侯府当姨太太，转瞬却被泽二奶奶略施手腕，推入一条看不见出口的路。',
      '日落之前，陈实一路小跑，赶在角门关闭之前回到侯府。',
    ],
  },
]

export const DEFAULT_ASSETS: StudioAsset[] = [
  {
    id: 'asset-chen-shi',
    kind: 'character',
    name: '陈实',
    subtitle: '主角 · 18 岁 · 骑奴',
    version: 'v1.2',
    status: 'locked',
    description: '年轻、克制但反应机敏。长期劳作让他的肩背结实，眼神保留着少年人的清亮。',
    sourceQuote: '“陈实原本也是安居之家……成为一名身份低下的骑奴。”',
    features: ['粗布短褐', '旧皮护腕', '清瘦结实', '不失警觉'],
    accent: '#c95a3b',
  },
  {
    id: 'asset-xiao-fengxiao',
    kind: 'character',
    name: '萧凤箫',
    subtitle: '关键人物 · 泽二奶奶',
    version: 'v1.0',
    status: 'locked',
    description: '侯府正妻，美貌与锋利并存。她的压迫感来自分寸感，而不是夸张的表情。',
    sourceQuote: '“泽二奶奶只是看他一眼，便如尖刀剜肉一般。”',
    features: ['华贵妇人', '丹凤眼', '珠钗', '冷静威压'],
    accent: '#305b70',
  },
  {
    id: 'asset-courtyard',
    kind: 'location',
    name: '甜水巷小院',
    subtitle: '场景 · 独门院落',
    version: 'v1.1',
    status: 'locked',
    description: '巷子深处的独门小院，窄门、旧砖、临窗的马厩共同构成逼仄的戏剧空间。',
    sourceQuote: '“甜水巷一座独门小院，陈实蹲在卧房窗户下面。”',
    features: ['窄门', '旧砖墙', '卧房窗', '临时马厩'],
    accent: '#aa7a47',
  },
  {
    id: 'asset-horse',
    kind: 'prop',
    name: '黑马',
    subtitle: '道具 · 顾承泽坐骑',
    version: 'v1.0',
    status: 'locked',
    description: '沉稳的黑色骏马，是连接侯府身份和甜水巷现场的关键物证。',
    sourceQuote: '“若是不在，他的马为何拴在外面。”',
    features: ['黑色鬃毛', '深棕鞍具', '铜扣缰绳', '侯府烙印'],
    accent: '#4b4d4a',
  },
  {
    id: 'asset-chair',
    kind: 'prop',
    name: '实木椅',
    subtitle: '道具 · 床边陈设',
    version: 'v1.0',
    status: 'review',
    description: '泽二奶奶离开后，顾承泽以蛮力掰断扶手，成为一处危险感很强的细节。',
    sourceQuote: '“咔嚓一声，直接将实木椅子的扶手掰下一块。”',
    features: ['深色木纹', '厚重扶手', '旧漆面', '断裂边缘'],
    accent: '#746a5b',
  },
]

export const DEFAULT_SHOTS: StudioShot[] = [
  {
    id: 'shot-1',
    sequence: 1,
    title: '牵马回院',
    chapterId: 'chapter-1',
    sourceText: '日落之前，陈实一路小跑，赶在角门关闭之前回到侯府。',
    action: '陈实牵着黑马快步穿过甜水巷，回头确认身后无人，暮色从巷口压进来。',
    camera: '中近景 · 低机位跟拍',
    durationSec: 5,
    assetIds: ['asset-chen-shi', 'asset-courtyard', 'asset-horse'],
    prompt:
      '古代大乾府城，暮色中的甜水巷，陈实牵着一匹黑马快步回到独门小院，少年骑奴穿粗布短褐与旧皮护腕，窄巷旧砖墙，临窗马厩，镜头低机位跟拍，风吹衣角，压迫感与紧迫感，写实电影质感，统一角色与场景设定，竖屏 9:16。',
    negativePrompt:
      '现代建筑，现代服饰，额外人物，文字水印，肢体变形，过度艳丽，镜头抖动，低清晰度。',
    status: 'generated',
  },
  {
    id: 'shot-2',
    sequence: 2,
    title: '巷口封门',
    chapterId: 'chapter-1',
    sourceText: '“把这巷子前后都给我堵了，一只耗子也别放出去！”',
    action: '萧凤箫带人从巷口压近，仆役分散到两侧，陈实在院门前猛然停住。',
    camera: '广角远景 → 推近特写',
    durationSec: 5,
    assetIds: ['asset-xiao-fengxiao', 'asset-courtyard'],
    prompt:
      '甜水巷旧砖小院前，萧凤箫带着侯府仆役从巷口有序压近，华贵妇人头戴珠钗，丹凤眼冷静锐利，陈实在院门前回头，广角远景缓慢推近，空气凝住，古代府城写实电影质感，竖屏 9:16。',
    negativePrompt: '现代警察，汽车，现代招牌，群像混乱，夸张怒吼，文字水印。',
    status: 'ready',
  },
  {
    id: 'shot-3',
    sequence: 3,
    title: '床底藏人',
    chapterId: 'chapter-1',
    sourceText: '顾承泽环顾四周，直接钻进了床底。咣当，外面的院门终于被撞开。',
    action: '顾承泽仓促躲入床底，陈实僵在床边，门板震动和脚步声一并逼近。',
    camera: '固定中景 · 门外声先入',
    durationSec: 5,
    assetIds: ['asset-chen-shi', 'asset-courtyard'],
    prompt:
      '甜水巷卧房内，陈实僵在床边，顾承泽慌乱钻入床底，门外传来沉重撞门声，窗纸透入冷色暮光，固定中景，声音先入画面，紧绷的古代宅院戏剧感，写实电影质感，竖屏 9:16。',
    negativePrompt: '现代家具，过度喜剧化，额外人物，文字水印，低清晰度。',
    status: 'draft',
  },
]

export const DEFAULT_TASKS: GenerationTask[] = [
  {
    id: 'gen_demo_001',
    shotId: 'shot-1',
    type: 'video',
    provider: 'MiniMax Adapter · local mock',
    model: 'MiniMax-H3',
    status: 'succeeded',
    createdAt: '2026-09-15T08:36:00+08:00',
    completedAt: '2026-09-15T08:36:19+08:00',
    requestSummary: '{"ratio":"9:16","resolution":"2K","durationSec":5,"vaultRef":"configured"}',
    assetVersions: ['陈实 v1.2', '甜水巷小院 v1.1', '黑马 v1.0'],
    prompt: DEFAULT_SHOTS[0].prompt,
    resultUrl: '/demo/ride-servant-shot-01.mp4',
  },
]

export function assetKindLabel(kind: AssetKind) {
  if (kind === 'character') return '人物'
  if (kind === 'location') return '场景'
  return '道具'
}

export function assetIconName(kind: AssetKind) {
  if (kind === 'character') return 'user'
  if (kind === 'location') return 'house'
  return 'cube'
}
