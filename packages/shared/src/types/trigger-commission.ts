import type { TriggerSource } from './trigger'
import type {
  MandateArchive,
  MandateTarget,
  TriggerMandate,
  TriggerMandateProject,
} from './trigger-mandate'

export interface CommissionScope {
  source: TriggerSource
  scope: string
}
export type CommissionOperator = MandateTarget & { operatorId: string }
export interface CommissionGrant extends CommissionScope {
  operator: CommissionOperator
  targets?: MandateTarget[]
  archive?: MandateArchive
  projectId?: string
}
export interface CommissionGrantsView {
  revision: number
  grants: CommissionGrant[]
  operators: (CommissionOperator & { label: string })[]
  scopes: (CommissionScope & { label: string })[]
  archives: MandateArchive[]
  projects: { id: string; name: string }[]
}
export type CommissionChange =
  | { kind: 'create' | 'update'; mandate: TriggerMandate }
  | { kind: 'project'; project: TriggerMandateProject }
export interface CommissionPreview {
  code: string
  title: string
  details: string[]
  expiresAt: number
}
