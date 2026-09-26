/**
 * useRanking —— 读取营位、因子、权重方案与否决记录，算出归一化得分与名次。
 * 被 `/`（名次表）、`/scoring`（拖动权重实时重排）、`/sites/:id`、`/map`、`/veto` 共同消费。
 *
 * 方案解析规则（每个营位独立）：
 *   1. 营位指定了 defaultProfileId 且方案仍存在 → 优先使用该指定方案（designated）；
 *   2. 未指定（null）→ 跟随当前方案（follow）：名次表/详情/地图为启用方案，评分页为临时比较方案；
 *   3. 指定的方案已被删除 → 回退到当前方案（fallback），并在名次表标出来源。
 * 临时比较方案只作用于 follow / fallback 的营位，不会改写任何营位的指定关系。
 *
 * 入参统一用 getter 函数，兼容 ref / computed / store 派生值，
 * 内部在独立 effectScope 中求值，保证 computed 依赖追踪正常且不泄漏。
 */
import { computed, effectScope, type ComputedRef } from 'vue'
import type { Campsite } from '@/types/campsite'
import type { FactorAssessment } from '@/types/factor'
import type {
  CurrentScheme,
  FactorKey,
  GradeThresholds,
  NormalizeMethod,
  ScoreProfile
} from '@/types/score'
import { DEFAULT_WEIGHTS } from '@/types/score'
import {
  buildFactorRows,
  buildNormalizedMatrix,
  gradeOf,
  rawValuesOf,
  weightedTotal,
  type Grade,
  type RawFactorValues,
  type SiteScore
} from '@/utils/score'

/** 方案来源：指定方案 / 跟随当前方案 / 指定方案缺失已回退 */
export type ProfileSource = 'designated' | 'follow' | 'fallback'

export const PROFILE_SOURCE_LABELS: Record<ProfileSource, string> = {
  designated: '指定方案',
  follow: '跟随当前',
  fallback: '指定缺失·回退'
}

/** 名次表 / 评分页表格里来源标签的配色 */
export function profileSourceTagType(source: ProfileSource): 'success' | 'info' | 'warning' {
  if (source === 'designated') return 'success'
  if (source === 'fallback') return 'warning'
  return 'info'
}

/** 来源文案（el-table 的 row 为 any，模板里直接索引 RECORD 会报 TS7053，故包一层） */
export function profileSourceLabel(source: ProfileSource): string {
  return PROFILE_SOURCE_LABELS[source]
}

/** 一个营位最终采用的评分方案（含来源标记） */
export interface ResolvedScheme extends CurrentScheme {
  source: ProfileSource
}

/**
 * 解析单个营位实际使用的评分方案。
 * 指定的方案被删除后回退到当前方案，source 记为 fallback 以便名次表标注。
 */
export function resolveSiteScheme(
  site: Campsite,
  profiles: ScoreProfile[],
  current: CurrentScheme
): ResolvedScheme {
  const designatedId = site.defaultProfileId
  if (designatedId == null) {
    return { ...current, source: 'follow' }
  }
  const found = profiles.find((p) => p.id === designatedId)
  if (!found) {
    return { ...current, source: 'fallback' }
  }
  return {
    weights: { ...DEFAULT_WEIGHTS, ...found.weights },
    normalize: found.normalize,
    thresholds: { ...found.thresholds },
    profileId: typeof found.id === 'number' ? found.id : null,
    profileName: found.name,
    source: 'designated'
  }
}

export interface RankingInput {
  /** 参与排名的营位集合 */
  sites: () => Campsite[]
  /** siteId -> 用于评分的因子记录（通常取最新一轮评估） */
  factorOf: (siteId: number) => FactorAssessment | null
  /** 全部可用权重方案，用于解析各营位指定的 defaultProfileId */
  profiles: () => ScoreProfile[]
  /**
   * 当前方案（名次表/详情/地图为启用方案；评分页为临时比较方案）。
   * 只作用于未指定方案的跟随项与指定缺失的回退项。
   */
  current: () => CurrentScheme
  /** 命中否决项的营位 id 集合 */
  vetoedIds: () => number[]
}

export interface RankingRow extends SiteScore {
  site: Campsite
  rank: number
  raw: RawFactorValues
  vetoTypes: string[]
  /** 实际采用的方案名（指定方案或当前方案） */
  profileName: string
  /** 方案来源：指定 / 跟随 / 回退 */
  profileSource: ProfileSource
  /** 实际采用的归一化方式 */
  normalize: NormalizeMethod
  /** 实际采用的等级阈值 */
  thresholds: GradeThresholds
}

export interface RankingState {
  /** 已按得分降序排列的名次 */
  ranked: ComputedRef<RankingRow[]>
  scoreOf: (siteId: number) => RankingRow | null
  gradeOfSite: (siteId: number) => Grade
  best: ComputedRef<RankingRow | null>
}

export function useRanking(input: RankingInput): RankingState {
  const scope = effectScope(true)

  const ranked = scope.run(() =>
    computed<RankingRow[]>(() => {
      const sites = input.sites() ?? []
      const profiles = input.profiles() ?? []
      const current = input.current()
      const vetoSet = new Set(input.vetoedIds() ?? [])

      const list = sites.filter((s): s is Campsite & { id: number } => typeof s.id === 'number')

      // 每个营位先解析出自己的评分方案：指定优先，未指定跟随当前，指定缺失则回退。
      const schemes = list.map((site) => resolveSiteScheme(site, profiles, current))

      // 关键：极差归一必须**同批营位一起比较**，逐条归一的话单条样本跨度为零会全部得 100。
      // 各营位的归一方式可能不同（来自各自方案），因此按归一方式分组：
      // 同组营位一次性归一化，再回填到每个营位；阈值分段天然逐条独立，也走同一分组逻辑。
      const entries = list.map((site, idx) => ({
        siteId: site.id,
        values: rawValuesOf(site, input.factorOf(site.id)),
        normalize: schemes[idx].normalize
      }))
      const matrix = new Map<number, Record<FactorKey, number>>()
      const methods: NormalizeMethod[] = ['minmax', 'threshold']
      for (const method of methods) {
        const group = entries.filter((e) => e.normalize === method)
        if (group.length === 0) continue
        const partial = buildNormalizedMatrix(group, method)
        partial.forEach((record, siteId) => matrix.set(siteId, record))
      }

      const rows: RankingRow[] = list.map((site, idx) => {
        const siteId = site.id
        const scheme = schemes[idx]
        const raw = entries[idx].values
        const normalized = matrix.get(siteId) ?? ({} as Record<FactorKey, number>)
        const vetoed = vetoSet.has(siteId)
        const total = weightedTotal(normalized, scheme.weights)
        return {
          site,
          siteId,
          total,
          // 风险否决仍压过得分：命中即短路为 C，与采用哪套方案/归一算法无关
          grade: gradeOf(total, scheme.thresholds, vetoed),
          vetoed,
          vetoTypes: [],
          rows: buildFactorRows(normalized, scheme.weights).map((row) => ({
            ...row,
            raw: raw[row.key]
          })),
          raw,
          rank: 0,
          profileName: scheme.profileName,
          profileSource: scheme.source,
          normalize: scheme.normalize,
          thresholds: scheme.thresholds
        } satisfies RankingRow
      })

      const sorted = rows.sort((a, b) => b.total - a.total)
      sorted.forEach((row, idx) => {
        row.rank = idx + 1
      })
      return sorted
    })
  ) as ComputedRef<RankingRow[]>

  function scoreOf(siteId: number): RankingRow | null {
    return ranked.value.find((r) => r.siteId === siteId) ?? null
  }

  function gradeOfSite(siteId: number): Grade {
    return scoreOf(siteId)?.grade ?? 'C'
  }

  const best = scope.run(() => computed<RankingRow | null>(() => ranked.value[0] ?? null)) as
    | ComputedRef<RankingRow | null>
    | undefined

  return {
    ranked,
    scoreOf,
    gradeOfSite,
    best: best ?? computed<RankingRow | null>(() => ranked.value[0] ?? null)
  }
}
