$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$apiPath = Join-Path $root 'src\routes\api.js'
if (!(Test-Path $apiPath)) { throw "Cannot find $apiPath" }
$content = [System.IO.File]::ReadAllText($apiPath)
$pattern = "(?s)router\.get\('/commands', asyncHandler\(async \(req, res\) => \{.*?\n\}\)\);(?=\r?\n// Generic states)"
$matches = [regex]::Matches($content, $pattern)
if ($matches.Count -ne 1) {
    throw "Expected exactly one GET /commands route before // Generic states; found $($matches.Count). No file was changed."
}
$replacement = @'
router.get('/commands', asyncHandler(async (req, res) => {
  const deviceId = intQuery(req.query.deviceId, 'deviceId');
  const roomId = intQuery(req.query.roomId, 'roomId');
  const status = req.query.status ? requiredString(req.query.status, 'status', 30) : null;
  if (status) checkStatus(status, ['pending', 'sent', 'completed', 'failed', 'timeout', 'cancelled'], 'status');
  const limit = limitQuery(req.query.limit, 100, 500);
  const offset = optionalInt(req.query.offset, 'offset', 0) ?? 0;
  const pool = await poolPromise;

  const filters = `
    FROM dbo.Commands c
    INNER JOIN dbo.Devices d ON d.DeviceId=c.DeviceId
    INNER JOIN dbo.Nodes n ON n.NodeId=d.NodeId
    LEFT JOIN dbo.Rooms r ON r.RoomId=n.RoomId
    WHERE (@deviceId IS NULL OR c.DeviceId=@deviceId)
      AND (@roomId IS NULL OR r.RoomId=@roomId)
      AND (@status IS NULL OR c.Status=@status)
  `;
  const totalResult = await pool.request()
    .input('deviceId', sql.Int, deviceId)
    .input('roomId', sql.Int, roomId)
    .input('status', sql.NVarChar(30), status)
    .query(`SELECT COUNT_BIG(1) AS total ${filters}`);

  const r = await pool.request()
    .input('deviceId', sql.Int, deviceId)
    .input('roomId', sql.Int, roomId)
    .input('status', sql.NVarChar(30), status)
    .input('limit', sql.Int, limit)
    .input('offset', sql.Int, offset)
    .query(`
      SELECT
        c.CommandId AS commandId,
        c.DeviceId AS deviceId,
        d.DeviceCode AS deviceCode,
        d.DeviceName AS deviceName,
        r.RoomId AS roomId,
        r.RoomCode AS roomCode,
        r.RoomName AS roomName,
        c.UserId AS userId,
        c.RequestedBy AS requestedBy,
        c.CommandType AS commandType,
        c.PayloadJson AS payloadJson,
        c.Status AS status,
        c.CreatedAt AS createdAt,
        c.CompletedAt AS completedAt
      ${filters}
      ORDER BY c.CreatedAt DESC,c.CommandId DESC
      OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
    `);

  const total = Number(totalResult.recordset[0]?.total || 0);
  const data = r.recordset.map(commandCompatibility);
  return resultOk(res, data, {
    count: data.length,
    limit,
    offset,
    total,
    page: Math.floor(offset / limit) + 1,
    totalPages: Math.ceil(total / limit),
  });
}));
'@
$backup = "$apiPath.command-history.bak"
Copy-Item $apiPath $backup -Force
$content = [regex]::Replace($content, $pattern, [System.Text.RegularExpressions.MatchEvaluator]{ param($m) $replacement }, 1)
[System.IO.File]::WriteAllText($apiPath, $content, [System.Text.UTF8Encoding]::new($false))
Write-Host "GET /commands now supports offset pagination. Backup: $backup" -ForegroundColor Green
Write-Host 'Run: node --check .\src\routes\api.js' -ForegroundColor Yellow
