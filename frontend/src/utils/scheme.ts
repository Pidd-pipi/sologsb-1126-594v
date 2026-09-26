/**
 * 营位评分方案解析 —— 每个营位优先使用**自己指定的方案**；
 * 未指定（defaultProfileId 为空）时才跟随「当前方案」；
 * 指定方案已被删除时回退到当前方案，并由调用方在名次表标出「回退」来源。
 *
 * 解析全程只读：临时比较方案只作用于跟随项，绝不改写营位上已有的指定关系。
 */
import type { Campsite } from '@/types/campsite'
import type { FactorWeights, GradeThresholds, NormalizeMethod, ScoreProfile } from '@/types/score'
import { DEFAULT_WEIGHTS } from '@/types/score'

/** 方案来源：自己指定 / 跟随当前方案 / 指定失效后回退到当前方案 */
export type SchemeSource = 'assigned' | 'following' | 'fallback'

/** 某个营位本次评分实际生效的方案 */
export interface ResolvedScheme {
  weights: FactorWeights
  normalize: NormalizeMethod
  thresholds: GradeThresholds
  /** 实际生效方案的名称（指定方案名或当前方案名） */
  profileName: string
  source: SchemeSource
}

/**
 * 解析上下文：
 * - profiles：全部可用方案，用于按营位 defaultProfileId 命中指定方案；
 * - current：当前方案。名次表/地图/详情页传启用方案，评分页传临时比较方案，
 *   因此评分页的临时调整只会落到跟随项上。
 */
export interface SchemeContext {
  profiles: ScoreProfile[]
  current: {
    weights: FactorWeights
    normalize: NormalizeMethod
    thresholds: GradeThresholds
    name: string
  }
}

export const DEFAULT_THRESHOLDS: GradeThresholds = { gradeA: 78, gradeB: 58 }

function copyCurrent(ctx: SchemeContext): ResolvedScheme {
  return {
    weights: { ...DEFAULT_WEIGHTS, ...ctx.current.weights },
    normalize: ctx.current.normalize,
    thresholds: { ...ctx.current.thresholds },
    profileName: ctx.current.name,
    source: 'following'
  }
}

/**
 * 解析单个营位的评分方案。
 * - defaultProfileId 命中现存方案 → 指定方案（source = assigned）；
 * - defaultProfileId 为空 → 当前方案（source = following）；
 * - defaultProfileId 有值但方案已删除 → 当前方案（source = fallback），
 *   营位上的悬空 id 原样保留，不写库，等用户在详情页改派。
 */
export function resolveSiteScheme(site: Campsite, ctx: SchemeContext): ResolvedScheme {
  const specifiedId = site.defaultProfileId
  if (specifiedId != null) {
    const own = ctx.profiles.find((p) => p.id === specifiedId)
    if (own) {
      return {
        weights: { ...DEFAULT_WEIGHTS, ...own.weights },
        normalize: own.normalize,
        thresholds: { ...own.thresholds },
        profileName: own.name,
        source: 'assigned'
      }
    }
    return { ...copyCurrent(ctx), source: 'fallback' }
  }
  return copyCurrent(ctx)
}

export const SCHEME_SOURCE_LABEL: Record<SchemeSource, string> = {
  assigned: '指定方案',
  following: '跟随当前',
  fallback: '指定失效·已回退'
}

/** 名次表来源标签对应的 Element Plus tag 配色 */
export const SCHEME_SOURCE_TAG: Record<SchemeSource, 'success' | 'info' | 'warning'> = {
  assigned: 'success',
  following: 'info',
  fallback: 'warning'
}
