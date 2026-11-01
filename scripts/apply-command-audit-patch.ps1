$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$apiPath = Join-Path $root 'src\routes\api.js'
if (!(Test-Path $apiPath)) { throw "Cannot find $apiPath" }

$content = [System.IO.File]::ReadAllText($apiPath)
$pattern = "(?s)// Commands;.*?router\.get\('/commands'.*?\n\}\)\);\r?\n\r?\n(?=// Generic states)"
$matches = [regex]::Matches($content, $pattern)
if ($matches.Count -ne 1) {
    throw "Expected exactly one existing Commands API section; found $($matches.Count). No file was changed."
}

$replacement = @'
// Commands; sender identity is taken from the authenticated CampusX session, never from request JSON.
router.post('/commands', asyncHandler(async (req, res) => {
  const commandType = requiredString(req.body.commandType ?? req.body.type, 'commandType', 100);
  const payloadJson = jsonString(req.body.payload ?? {}, 'payload', false);
  const deviceId = req.body.deviceId == null ? null : requiredInt(req.body.deviceId, 'deviceId');
  const deviceCode = req.body.deviceCode == null ? null : requiredString(req.body.deviceCode, 'deviceCode', 100);
  if (deviceId === null && deviceCode === null) throw new HttpError(400, 'VALIDATION_ERROR', 'deviceId or deviceCode is required');

  const requestedBy = String(req.dashboardUser?.username || '').trim();
  if (!requestedBy) throw new HttpError(401, 'AUTH_REQUIRED', 'A signed-in CampusX user is required to send commands');

  const pool = await poolPromise;
  const find = await pool.request()
    .input('deviceId', sql.Int, deviceId)
    .input('deviceCode', sql.NVarChar(100), deviceCode)
    .query(`
      SELECT TOP (1)
        d.DeviceId, d.DeviceCode, d.DeviceName, d.IsActive,
        n.IsActive AS nodeActive,
        r.RoomId, r.RoomCode, r.RoomName
      FROM dbo.Devices d
      INNER JOIN dbo.Nodes n ON n.NodeId=d.NodeId
      LEFT JOIN dbo.Rooms r ON r.RoomId=n.RoomId
      WHERE (@deviceId IS NOT NULL AND d.DeviceId=@deviceId)
         OR (@deviceCode IS NOT NULL AND d.DeviceCode=@deviceCode)
    `);
  const device = find.recordset[0];
  if (!device || !device.IsActive || !device.nodeActive) throw new HttpError(404, 'NOT_FOUND', 'Device not found or inactive');

  const insert = await pool.request()
    .input('deviceId', sql.Int, device.DeviceId)
    .input('type', sql.NVarChar(100), commandType)
    .input('payload', sql.NVarChar(sql.MAX), payloadJson)
    .input('requestedBy', sql.NVarChar(100), requestedBy)
    .query(`
      INSERT INTO dbo.Commands(DeviceId, UserId, RequestedBy, CommandType, PayloadJson, Status)
      OUTPUT inserted.CommandId AS commandId,
             inserted.DeviceId AS deviceId,
             inserted.RequestedBy AS requestedBy,
             inserted.CommandType AS commandType,
             inserted.PayloadJson AS payloadJson,
             inserted.Status AS status,
             inserted.CreatedAt AS createdAt
      VALUES(@deviceId, NULL, @requestedBy, @type, @payload, N'pending')
    `);
  const command = insert.recordset[0];
  const topic = `${env.commandTopicPrefix}/${encodeURIComponent(device.DeviceCode)}/commands`;

  // Best-effort audit entry. The Commands row itself remains the primary command history.
  try {
    const details = JSON.stringify({
      requestedBy,
      deviceCode: device.DeviceCode,
      deviceName: device.DeviceName,
      roomId: device.RoomId,
      roomCode: device.RoomCode,
      roomName: device.RoomName,
      commandType,
      payload: JSON.parse(payloadJson),
      topic,
    });
    await pool.request()
      .input('action', sql.NVarChar(100), 'command_sent')
      .input('entityType', sql.NVarChar(100), 'Command')
      .input('entityId', sql.NVarChar(100), String(command.commandId))
      .input('details', sql.NVarChar(sql.MAX), details)
      .query(`INSERT INTO dbo.Audit_Logs(Action, EntityType, EntityId, DetailsJson) VALUES(@action,@entityType,@entityId,@details)`);
  } catch (auditError) {
    console.warn('[Audit] Command was created but its Audit_Logs entry failed:', auditError.message);
  }

  try {
    await publish(topic, {
      command_id: String(command.commandId),
      type: commandType,
      payload: JSON.parse(payloadJson),
    });
    const sent = await pool.request()
      .input('id', sql.BigInt, command.commandId)
      .query(`
        UPDATE dbo.Commands SET Status=N'sent'
        OUTPUT inserted.CommandId AS commandId,
               inserted.DeviceId AS deviceId,
               inserted.RequestedBy AS requestedBy,
               inserted.CommandType AS commandType,
               inserted.PayloadJson AS payloadJson,
               inserted.Status AS status,
               inserted.CreatedAt AS createdAt,
               inserted.CompletedAt AS completedAt
        WHERE CommandId=@id AND Status=N'pending'
      `);
    const value = sent.recordset[0] || command;
    const eventData = {
      ...value,
      deviceCode: device.DeviceCode,
      deviceName: device.DeviceName,
      roomId: device.RoomId,
      roomCode: device.RoomCode,
      roomName: device.RoomName,
      topic,
    };
    emitData('command', eventData);
    return res.status(201).json({ status: 'ok', message: 'Command published; awaiting device response', data: eventData });
  } catch (error) {
    await pool.request()
      .input('id', sql.BigInt, command.commandId)
      .query(`UPDATE dbo.Commands SET Status=N'failed', CompletedAt=SYSUTCDATETIME() WHERE CommandId=@id AND Status IN (N'pending',N'sent')`);
    throw new HttpError(503, 'MQTT_PUBLISH_FAILED', `Command was saved but MQTT publish failed: ${error.message}`);
  }
}));

router.get('/commands', asyncHandler(async (req, res) => {
  const deviceId = intQuery(req.query.deviceId, 'deviceId');
  const roomId = intQuery(req.query.roomId, 'roomId');
  const status = req.query.status ? requiredString(req.query.status, 'status', 30) : null;
  if (status) checkStatus(status, ['pending', 'sent', 'completed', 'failed', 'timeout', 'cancelled'], 'status');
  const limit = limitQuery(req.query.limit, 100, 500);
  const pool = await poolPromise;
  const r = await pool.request()
    .input('deviceId', sql.Int, deviceId)
    .input('roomId', sql.Int, roomId)
    .input('status', sql.NVarChar(30), status)
    .input('limit', sql.Int, limit)
    .query(`
      SELECT TOP (@limit)
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
      FROM dbo.Commands c
      INNER JOIN dbo.Devices d ON d.DeviceId=c.DeviceId
      INNER JOIN dbo.Nodes n ON n.NodeId=d.NodeId
      LEFT JOIN dbo.Rooms r ON r.RoomId=n.RoomId
      WHERE (@deviceId IS NULL OR c.DeviceId=@deviceId)
        AND (@roomId IS NULL OR r.RoomId=@roomId)
        AND (@status IS NULL OR c.Status=@status)
      ORDER BY c.CreatedAt DESC,c.CommandId DESC
    `);
  return resultOk(res, r.recordset, { count: r.recordset.length, limit });
}));

'@

$backup = "$apiPath.command-audit.bak"
Copy-Item $apiPath $backup -Force
$content = [regex]::Replace($content, $pattern, [System.Text.RegularExpressions.MatchEvaluator]{ param($m) $replacement }, 1)
[System.IO.File]::WriteAllText($apiPath, $content, [System.Text.UTF8Encoding]::new($false))
Write-Host "Command API patched. Backup: $backup" -ForegroundColor Green
Write-Host 'Next: execute sql/20261031_AddCommandRequestedBy.sql in CampusX, then run node --check src/routes/api.js.' -ForegroundColor Yellow
