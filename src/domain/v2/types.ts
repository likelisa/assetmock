import type { Profile, Fact, LoanOffer } from '../types';
export type Target = 'car' | 'home';
export type PathId = 'a' | 'b';
export const ids: PathId[] = ['a', 'b'];
export type Method = 'full' | 'low' | 'high';
export type Choice = 'lower' | 'wait' | 'temporary' | 'accept' | 'decline';
export type EventKind = 'medical' | 'jobLoss' | 'bonusDelay' | 'marketDrop' | 'career';
export type Draws = Record<EventKind, number>;
export type Character = Profile & { target: Target; rent: number; age: number };
export interface Input { custom?: import('./custom').CustomGoal; target: Target; profileId: string; price: number; paths: [PlanInput, PlanInput] }
export interface PlanInput { method: Method; downPercent: number; term: number; offerId: string }
export interface Plan extends PlanInput { id: PathId; label: string; down: number; principal: number; payment: number; offer: LoanOffer }
export interface Rules { version: '0.2.0' | '0.3.0' | '0.4.0'; months: number; startMonth: string; probabilities: Draws; medicalCost: number; medicalDuration: number; medicalCooldown: number; jobCooldown: number; careerCooldown: number; marketDropRate: string }
export interface SimulationSource { kind: 'ledger' | 'demo'; workspaceId: string; goalId: string | null; signature?: string; confirmedAt?: string; notes: string[]; sourceAssets?: unknown; confirmed?: unknown }
export interface Setup { source?: SimulationSource; input: Input; profile: Character; plans: Record<PathId, Plan>; rules: Rules; runningCost: number; depreciation: number }
export interface Employment { salary: number; livingExtra: number; jobEligible: number; careerEligible: number; job?: { month: number; salary: number; choice: Choice }; promotion?: { month: number; salary: number } }
export interface Balance { cash: number; fund: number; asset: number; debt: number; loan: number; paid: number; netWorth: number; lastMonth: number; status: 'running' | 'completed' | 'failed'; employment: Employment; failure?: { month: number; shortfall: number }; paidOffMonth?: number }
export interface Life { medicalUntil: number; medicalEligible: number; bonusDue: number; bonusOriginal: number }
export interface State { month: number; life: Life; paths: Record<PathId, Balance> }
export interface Event { kind: EventKind; paths: PathId[]; title: string }
export interface Decision { path: PathId; kind: 'jobLoss' | 'career'; options: Choice[] }
export interface Pending { month: number; events: Event[]; decisions: Decision[]; notices: string[] }
export interface Selection { path: PathId; kind: 'jobLoss' | 'career'; choice: Choice }
export interface ChoiceRecord extends Selection { month: number; inherited?: boolean }
export interface Ledger { salary: number; bonus: number; living: number; running: number; medical: number; debtPrincipal: number; loanPrincipal: number; interest: number; fundLoss: number; fundSale: number; depreciation: number }
export interface Month { month: number; events: Event[]; choices: ChoiceRecord[]; paths: Record<PathId, { state: Balance; ledger: Ledger | null }>; life: Life; milestones: string[] }
export interface Run { schemaVersion: 2; id: string; sessionId: string; createdAt: string; setup: Setup; tape: Draws[]; initial: State; state: State; history: Month[]; version: number; status: 'running' | 'waiting' | 'ended'; pending?: Pending; inherited: ChoiceRecord[]; notices: string[]; parentId?: string; stageStart: number; stopReason: string }
export interface Trial { path: PathId; choice: Choice; funds: number; lastMonth: number; failureMonth?: number }
export interface PublicRun { source?: SimulationSource; schemaVersion: 2; id: string; version: number; input: Input; profile: Character; plans: Record<PathId, Plan>; month: number; totalMonths: number; status: Run['status']; paths: Record<PathId, Balance>; pending?: Pending; trials: Trial[]; history: Month[]; timeline: { month: number; a: number | null; b: number | null }[]; facts: Fact[]; annual: { year: number; facts: Fact[] }[]; stageStart: number; stopReason: string; notices: string[]; nextMonth: number; rules: Rules; summary: { commonMonth: number; difference: number; facts: Fact[] } }
