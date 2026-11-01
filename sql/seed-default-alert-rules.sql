/*
  Optional defaults for the rule-driven alert engine.
  Safe to run more than once. Run in the CampusX database in SSMS.
  Rules are editable through POST/PATCH /api/v1/alert-rules after seeding.
*/
USE CampusX;
GO

DECLARE @temperatureMetricId INT;
SELECT @temperatureMetricId = MetricId
FROM dbo.Metrics
WHERE MetricCode = N'temperature';

IF @temperatureMetricId IS NULL
BEGIN
    THROW 51001, 'Metric temperature is missing. Create it through /api/v1/metrics or add it to dbo.Metrics first.', 1;
END;

IF NOT EXISTS (
    SELECT 1 FROM dbo.Alert_Rules
    WHERE MetricId = @temperatureMetricId AND RuleName = N'High temperature warning' AND Operator = N'>' AND Threshold = 30
)
BEGIN
    INSERT INTO dbo.Alert_Rules(MetricId, RoomId, RuleName, Operator, Threshold, DurationSeconds, IsEnabled, ConfigJson)
    VALUES(@temperatureMetricId, NULL, N'High temperature warning', N'>', 30, 0, 1, N'{"severity":"warning"}');
END;

IF NOT EXISTS (
    SELECT 1 FROM dbo.Alert_Rules
    WHERE MetricId = @temperatureMetricId AND RuleName = N'Critical temperature' AND Operator = N'>' AND Threshold = 40
)
BEGIN
    INSERT INTO dbo.Alert_Rules(MetricId, RoomId, RuleName, Operator, Threshold, DurationSeconds, IsEnabled, ConfigJson)
    VALUES(@temperatureMetricId, NULL, N'Critical temperature', N'>', 40, 0, 1, N'{"severity":"critical"}');
END;

PRINT 'CampusX default temperature alert rules are ready.';
GO
