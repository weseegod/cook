/**
 * The tasks list body, shared by the Tools panel's Activity tab and the header's tasks strip:
 * the pane's sections (`views/tasks_pane.rs`), each row with its kind, live elapsed and stop
 * control. A single-section list renders flat — the row's own kind label already says what it is.
 */
import { Fragment } from "react";
import type { ActivityItem } from "../../state/activity";
import { ActivityRowView } from "./activity-row";
import { groupActivityRows } from "./activity-groups";

export function ActivityList({
  rows,
  now,
  busyId,
  onKill,
  onOpen,
  testIdPrefix,
  label,
}: {
  rows: readonly ActivityItem[];
  now: number;
  busyId: string | null;
  onKill: (item: ActivityItem) => void;
  onOpen?: (item: ActivityItem) => void;
  testIdPrefix: string;
  label: string;
}) {
  const groups = groupActivityRows(rows);
  const sections = groups.length > 1;
  return (
    <div className="activity-list" role="list" aria-label={label}>
      {groups.map((group) => (
        <Fragment key={group.kind}>
          {sections && (
            <div className="activity-group" role="presentation" data-testid={`${testIdPrefix}-group-${group.kind}`}>
              <span>{group.label}</span>
              <span className="activity-group-count">{group.rows.length}</span>
            </div>
          )}
          {group.rows.map((item) => (
            <ActivityRowView
              key={`${item.kind}:${item.id}`}
              item={item}
              now={now}
              busy={busyId === item.id}
              onKill={() => onKill(item)}
              onOpen={onOpen}
              testIdPrefix={testIdPrefix}
            />
          ))}
        </Fragment>
      ))}
    </div>
  );
}
