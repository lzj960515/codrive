# Milestones and continuous planning

This page defines stage goals, evidence-driven planning, persistent conversations, and completion. It applies within one Codrive project; cross-project goals and independent milestone cancellation, archive, or reopening are outside this model.

## Ownership

`PROJECT.md` owns current product capabilities and long-term rules. A `Milestone` owns a stage goal through `title`, `description`, and `acceptanceCriteria`; its description carries scope and accepted decision boundaries. Tasks own concrete deliveries and optionally reference one milestone in the same project. Independent tasks remain supported.

A milestone has `active | done` business status, a separate definition version, planning revisions, a persistent conversation, and its current planning execution. Waiting for a decision, waiting for tasks, and evaluating are execution or activity facts, not extra milestone status values. Current interpretation is reconstructed from typed activities in the existing event log. Discovery, assessment, resolution, and plans do not have separate entity stores.

See [Product facts lifecycle](./product-facts.md) for document acceptance and startup migration. Adding work uses its own decision summary; an unchanged product contract needs no edit or product revision.

## Planning and delivery

Registration accepts tasks, milestones, or both, with at least one source of work. A milestone with no tasks triggers initial assessment. Its owner checks current evidence and produces enough work to begin; later evidence can add, amend, cancel, or replace work within the accepted goal. Project `replan` refreshes planning for active milestones as well as project selection, allowing an initial assessment whose conversation creation failed to run again through normal scheduling eligibility.

Project selection decides which eligible tasks can start across all milestones and independent work. Milestone assessment decides what is still needed. One automatic planning turn per project coordinates both roles; assessment does not consume an ordinary task slot. Selection still requires capacity. New facts trigger planning; free capacity alone does not repeatedly invoke AI.

The coordinator alternates selection and assessment so that discoveries do not indefinitely displace executable work. Reports capture the input revision they processed. Evidence arriving during a turn remains pending, while target or task-version conflicts require rereading before applying the affected plan. Final completion requires a current target and evidence baseline.

Every concrete delivery follows ordinary Work, independent Review, and Integration/completion judgment. Investigation and actual verification are ordinary tasks when they require substantial work. An owner may perform small read-only checks directly. A code-free delivery preserves its evidence contract and does not invent a Git commit.

## Discoveries and decisions

`task.report_discovery` records a stable request ID, current task attempt, summary, evidence, and affected tasks. It is non-terminal and does not consume the current task report opportunity. Review `findings` continue to mean actionable delivery blockers.

Assessment starts for an initial goal, changed goal/task definitions or product facts, explicit discoveries, user decisions, and manual replanning. A member task reaching `done` or `cancelled` requests assessment only when an unresolved resolution lists it in `waitForTaskIds`, or every member task has ended. Historical resolved waits have no effect. Work, Review, integration transitions, local blockers, input requests, scheduled waits, and retries stay within the task lifecycle; cross-task implications use `task.report_discovery`. Cancellations applied by the owner's accepted plan request another turn only when an unresolved prerequisite still references those cancelled tasks after the plan's resolutions are applied.

The owner reads both explicit discoveries and valid stage reports when assessment runs; retaining a report as evidence does not itself request assessment. It distinguishes facts from hypotheses, checks missing consumers and failed premises, and records a disposition. Two sources can refer to the same investigation or business question without creating duplicate tasks. Idempotency handles retried requests; AI handles semantic duplication with source references.

A `milestone.report` carries execution and report opportunity identity, definition and planning versions, an outcome, and optional evidence and plan. Outcomes are `progress`, `needs_input`, `blocked`, and `completed`. Plans contain task additions, optimistic unstarted-task updates, justified cancellations, and resolutions. New tasks have keys local to that report; resolutions may reference those keys or existing IDs, and accepted records persist resolved task IDs.

A resolution references the activities it addresses and describes why. It may contain a question, `affectedTaskIds`, and `waitForTaskIds`. Unresolved activities project into questions and task restrictions. An answer does not itself prove required delivery: when the user chooses to migrate a consumer, the same accepted plan resolves the scope question while retaining affected deletion tasks and their wait for the new migration task. No independent hold entity is needed.

Requests to the user concern new scope, changed business results, data semantics, or permissions. Already accepted goals authorize necessary investigation, omitted work, and implementation decisions. A questionable premise is investigated before asking the user to decide a fact.

Waiting for the user ends that evaluation turn, not the owner's responsibility. New evidence can start another turn in the same conversation, extend the current question, or resolve it. Multiple sources share one current question. A late answer to a superseded question is checked against the current state before it can influence the plan. Unrelated work and investigations needed to answer the question remain eligible.

## Restricting work already in progress

Persist the affecting activity before interrupting an in-flight task. Dispatch, retry, recovery, and integration check unresolved restrictions. Confirmed interruption preserves the original task, attempt, conversation, candidate, and checkpoint while releasing task capacity and integration ownership. An unconfirmed interruption retains its actual occupancy and exposes the failure; neither interruption nor cancellation reverses completed external operations.

After the required evidence resolves the activity, requeue the original task through normal capacity and integration checks. A still-valid task keeps its definition and resumes with the current decision. An invalidated delivery uses the existing cancellation path and, if needed, an ordinary replacement task. Tasks that have already started retain their original definition and milestone membership.

## Completion and conversations

All member tasks reaching terminal states triggers assessment, not automatic milestone completion. The owner checks each acceptance criterion against effective reviewed evidence, unresolved sources and questions, and the reasons for cancellation or replacement. Missing deployment, migration, or runtime evidence creates an ordinary verification task. Completion preserves its definition/evidence baseline and stops automatic evaluation; a new goal is subsequent work.

| Role | Persistent conversation in the project repository |
| --- | --- |
| Project selection | `[调度] <project name>`, referenced by `planningThreadId` |
| Milestone assessment | `[里程碑] <milestone title>`, referenced by `threadId` |
| Work and integration | Existing task work conversation |
| Independent Review | Existing `[review] <task title>` conversation |

All conversations are visible in the current project. Each turn rereads authoritative context. Automatic dispatch checks for an already active role conversation, including a user-started reply, and accepts plans through serialized identity/version validation. After a milestone reaches `done`, replies in its persistent conversation remain historical discussion outside the planning execution lifecycle, preserving completion and leaving the project's planning slot available. Model routing, retries, report opportunities, and recovery reuse planning execution mechanisms.

Context reads preserve the identity of an active planning execution. Live `turn/started` notifications adopt user replies; context synchronization of an inactive owner requires an active thread with exactly one in-progress turn. Historical or ambiguous snapshots cannot replace a dispatched execution or erase its accepted report. An accepted milestone assessment remains effective if its turn is interrupted: recovery settles that execution and only schedules another assessment when a newer planning revision exists.

The four managed Skills remain the entry points: Forge registers product goals, Work adds or revises authorized work, Task routes selection/assessment/task stages, and Control reads current progress and applies confirmed controls. Detailed AI judgment lives in `codrive-task/references/planning.md`; this page owns the product lifecycle.


## Project workspace

The task tab retains all task states, including completed and cancelled work.
One row of cards offers only active milestones as filters. With no selected card,
the board shows every project task, including independent tasks and tasks from
completed milestones. Reset clears the filter. Each card keeps its title, status,
and summary; a separate detail link beside the title opens the familiar side panel
without changing the filter. Selecting a milestone includes all its task states.

The milestone tab lists all goals with active and completed filters. Its detail
shows the goal, acceptance criteria, current questions, evidence, and every
associated task directly. Opening a task keeps a return path to the milestone.
Completion remains an explicit milestone assessment, never a task-count inference.

Project information stays on a separate page for `PROJECT.md`, model settings,
and registration details. Workspace URLs retain the project, view, filters, and
open detail when reloading or returning from project information. Archived
projects retain read access to goals and tasks through the same workspace;
scheduling stays paused until the existing restore and resume controls are used.

Users can cancel unfinished tasks from task details when no AI turn is executing.
The HTTP view derives eligibility from execution state, independently of the board
stage. The serialized cancellation command checks current state again and reads
any attached conversation to reject a manually resumed active turn. Pending,
running, and active report turns cannot be cancelled; idle blockers, decisions,
scheduled waits, and capacity retry waits can. Cancellation preserves history,
clears scheduled resumes, and uses the existing planning and milestone updates.
Agent-directed and project cancellation retain their explicit interruption path.
