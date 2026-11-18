// Outcomes cover retained observations. A later resume can change the latest state.
// Older clients have no task identity and cannot be grouped into distinct tasks.
export const DOWNLOAD_OUTCOMES_SQL = `
WITH lifecycle AS (
  SELECT install_id, occurred_at, received_at, event_id,
    json_extract(properties_json, '$.task_id') AS task_id,
    json_extract(properties_json, '$.attempt_id') AS attempt_id,
    json_extract(properties_json, '$.state') AS state
  FROM events WHERE event_name = 'download_task_state'
), ranked AS (
  SELECT *, ROW_NUMBER() OVER (
    PARTITION BY install_id, task_id
    ORDER BY julianday(occurred_at) DESC, julianday(received_at) DESC,
      CASE WHEN state = 'started' THEN 0 ELSE 1 END DESC, event_id DESC
  ) AS position,
    MAX(CASE WHEN state = 'failed' THEN 1 ELSE 0 END)
      OVER (PARTITION BY install_id, task_id) AS had_failure
  FROM lifecycle WHERE task_id IS NOT NULL
)
SELECT COUNT(*) AS observed_tasks,
  COALESCE(SUM(state = 'completed'), 0) AS completed_tasks,
  COALESCE(SUM(state = 'completed' AND had_failure = 1), 0) AS recovered_tasks,
  COALESCE(SUM(state = 'failed'), 0) AS latest_failed_tasks,
  COALESCE(SUM(state = 'completed_with_gaps'), 0) AS completed_with_gaps_tasks,
  COALESCE(SUM(state = 'cancelled'), 0) AS cancelled_tasks,
  COALESCE(SUM(state = 'started'), 0) AS in_progress_or_unreported_tasks,
  (SELECT COUNT(*) FROM (
    SELECT DISTINCT install_id, attempt_id FROM lifecycle WHERE task_id IS NULL
  )) AS legacy_unlinked_attempts
FROM ranked WHERE position = 1
`
