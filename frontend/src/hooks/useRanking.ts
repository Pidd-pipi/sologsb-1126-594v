/**
 * useRanking —— 读取营位、因子、方案与否决记录，按「每个营位各自解析的评分方案」
 * 算出归一化得分与名次。被 `/`（名次表）、`/scoring`（临时比较）、`/map`、`/sites/:id`、`/veto` 共同消费。
 *
 * 方案解析规则见 utils/scheme.ts：指定方案优先，未指定跟随当前方案，
 * 指定失效回退当前方案。评分页传入的当前方案是临时比较方案，只影响跟随项。
 *
 * 入参统一用 getter 函数，兼容 ref / computed / store 派生值，
 * 内部在独立 effectScope 中求值，保证 computed 依赖追踪正常且不泄漏。
 */
import { computed, effectScope, type ComputedRef } from 'vue'
import type { Campsite } from '@/types/campsite'
import type { FactorAssessment } from '@/types/factor'
import type { FactorKey, NormalizeMethod } from '@/types/score'
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
import type { ResolvedScheme } from '@/utils/scheme'

export interface RankingInput {
  /** 参与排名的营位集合 */
  sites: () => Campsite[]
  /** siteId -> 用于评分的因子记录（通常取最新一轮评估） */
  factorOf: (siteId: number) => FactorAssessment | null
  /** 每个营位实际采用的方案（指定优先、未指定跟随、失效回退） */
  schemeOf: (site: Campsite) => ResolvedScheme
  /** 命中否决项的营位 id 集合 */
  vetoedIds: () => number[]
}

export interface RankingRow extends SiteScore {
  site: Campsite
  rank: number
  raw: RawFactorValues
  /** 该营位本次生效的评分方案与来源标记 */
  scheme: ResolvedScheme
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
      const vetoSet = new Set(input.vetoedIds() ?? [])

      const list = sites.filter((s): s is Campsite & { id: number } => typeof s.id === 'number')

      // 先逐营位解析方案、收集原始指标。
      const entries = list.map((site) => ({
        site,
        siteId: site.id,
        scheme: input.schemeOf(site),
        values: rawValuesOf(site, input.factorOf(site.id))
      }))

      // 归一化按「归一方式」分批：极差归一必须在同批营位间比较（单条跨度为零会全部得 100），
      // 故把同方法的营位放进同一批一次性归一；阈值分段逐营位独立，分批不影响结果。
      // 这样指定「阈值分段」方案的营位和跟随「极差归一」方案的营位可以同榜比较。
      const normalizedById = new Map<number, Record<FactorKey, number>>()
      const methods: NormalizeMethod[] = ['minmax', 'threshold']
      for (const method of methods) {
        const cohort = entries.filter((e) => e.scheme.normalize === method)
        if (cohort.length === 0) continue
        const matrix = buildNormalizedMatrix(
          cohort.map((e) => ({ siteId: e.siteId, values: e.values })),
          method
        )
        matrix.forEach((record, siteId) => normalizedById.set(siteId, record))
      }

      const rows: RankingRow[] = entries.map((entry) => {
        const { site, siteId, scheme } = entry
        const raw = entry.values
        const normalized = normalizedById.get(siteId) ?? ({} as Record<FactorKey, number>)
        const vetoed = vetoSet.has(siteId)
        const total = weightedTotal(normalized, scheme.weights)
        return {
          site,
          siteId,
          total,
          // 否决短路压过一切得分：命中即 C，换权重 / 换归一算法都不改判。
          grade: gradeOf(total, scheme.thresholds, vetoed),
          vetoed,
          vetoTypes: [],
          rows: buildFactorRows(normalized, scheme.weights).map((row) => ({
            ...row,
            raw: raw[row.key]
          })),
          raw,
          scheme,
          rank: 0
        } satisfies RankingRow
      })

      // 各营位按自己方案算出的总分同榜排序。
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
