-- Check comment status for the schedule
SELECT id, videoId, status, errorMessage, createdAt, postedAt
FROM Comment
WHERE scheduleId = 'f33d1cc7-e970-4182-9b01-618cae6910c8'
ORDER BY createdAt DESC
LIMIT 10;
