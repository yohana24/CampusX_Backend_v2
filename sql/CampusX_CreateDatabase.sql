/*
 Campus X - SQL Server initial schema
 Safe setup: creates a NEW database named CampusX.
 Does not modify or delete the existing smart_campus MySQL database.
 Run this script in SQL Server Management Studio (SSMS).
*/

USE master;
GO

IF DB_ID(N'CampusX') IS NULL
BEGIN
    CREATE DATABASE CampusX;
END
GO

USE CampusX;
GO

/* 1. Physical rooms/labs */
CREATE TABLE dbo.Rooms (
    RoomId INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_Rooms PRIMARY KEY,
    RoomCode NVARCHAR(50) NOT NULL,
    RoomName NVARCHAR(150) NOT NULL,
    Capacity INT NULL,
    LocationDetails NVARCHAR(250) NULL,
    IsActive BIT NOT NULL CONSTRAINT DF_Rooms_IsActive DEFAULT (1),
    CONSTRAINT UQ_Rooms_RoomCode UNIQUE (RoomCode),
    CONSTRAINT CK_Rooms_Capacity CHECK (Capacity IS NULL OR Capacity >= 0)
);
GO

/* 2. Controller/node categories and nodes (e.g. ESP32) */
CREATE TABLE dbo.Node_Types (
    NodeTypeId INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_Node_Types PRIMARY KEY,
    TypeName NVARCHAR(100) NOT NULL CONSTRAINT UQ_Node_Types_TypeName UNIQUE
);
GO

CREATE TABLE dbo.Nodes (
    NodeId INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_Nodes PRIMARY KEY,
    RoomId INT NOT NULL,
    NodeTypeId INT NOT NULL,
    NodeCode NVARCHAR(100) NOT NULL,
    FirmwareVersion NVARCHAR(100) NULL,
    LastSeenAt DATETIME2(3) NULL,
    IsActive BIT NOT NULL CONSTRAINT DF_Nodes_IsActive DEFAULT (1),
    ConfigJson NVARCHAR(MAX) NULL,
    CONSTRAINT UQ_Nodes_NodeCode UNIQUE (NodeCode),
    CONSTRAINT FK_Nodes_Rooms FOREIGN KEY (RoomId) REFERENCES dbo.Rooms(RoomId),
    CONSTRAINT FK_Nodes_Node_Types FOREIGN KEY (NodeTypeId) REFERENCES dbo.Node_Types(NodeTypeId),
    CONSTRAINT CK_Nodes_ConfigJson CHECK (ConfigJson IS NULL OR ISJSON(ConfigJson) = 1)
);
GO

/* 3. Device categories and physical/logical devices */
CREATE TABLE dbo.Device_Types (
    DeviceTypeId INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_Device_Types PRIMARY KEY,
    TypeName NVARCHAR(100) NOT NULL CONSTRAINT UQ_Device_Types_TypeName UNIQUE,
    Category NVARCHAR(50) NOT NULL, -- sensor, actuator, camera, other
    DefaultConfigJson NVARCHAR(MAX) NULL,
    CONSTRAINT CK_Device_Types_Category CHECK (Category IN (N'sensor', N'actuator', N'camera', N'other')),
    CONSTRAINT CK_Device_Types_ConfigJson CHECK (DefaultConfigJson IS NULL OR ISJSON(DefaultConfigJson) = 1)
);
GO

CREATE TABLE dbo.Devices (
    DeviceId INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_Devices PRIMARY KEY,
    NodeId INT NOT NULL,
    DeviceTypeId INT NOT NULL,
    DeviceCode NVARCHAR(100) NOT NULL,
    DeviceName NVARCHAR(150) NOT NULL,
    Status NVARCHAR(30) NOT NULL CONSTRAINT DF_Devices_Status DEFAULT (N'unknown'),
    IsActive BIT NOT NULL CONSTRAINT DF_Devices_IsActive DEFAULT (1),
    ConfigJson NVARCHAR(MAX) NULL,
    CONSTRAINT UQ_Devices_DeviceCode UNIQUE (DeviceCode),
    CONSTRAINT FK_Devices_Nodes FOREIGN KEY (NodeId) REFERENCES dbo.Nodes(NodeId),
    CONSTRAINT FK_Devices_Device_Types FOREIGN KEY (DeviceTypeId) REFERENCES dbo.Device_Types(DeviceTypeId),
    CONSTRAINT CK_Devices_Status CHECK (Status IN (N'unknown', N'online', N'offline', N'fault', N'maintenance')),
    CONSTRAINT CK_Devices_ConfigJson CHECK (ConfigJson IS NULL OR ISJSON(ConfigJson) = 1)
);
GO

/* 4. Generic measurement definitions */
CREATE TABLE dbo.Metrics (
    MetricId INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_Metrics PRIMARY KEY,
    MetricCode NVARCHAR(100) NOT NULL CONSTRAINT UQ_Metrics_MetricCode UNIQUE,
    DisplayName NVARCHAR(150) NOT NULL,
    DefaultUnit NVARCHAR(30) NULL,
    DataType NVARCHAR(30) NOT NULL CONSTRAINT DF_Metrics_DataType DEFAULT (N'numeric'),
    MetadataJson NVARCHAR(MAX) NULL,
    CONSTRAINT CK_Metrics_DataType CHECK (DataType IN (N'numeric', N'text', N'json', N'boolean')),
    CONSTRAINT CK_Metrics_MetadataJson CHECK (MetadataJson IS NULL OR ISJSON(MetadataJson) = 1)
);
GO

CREATE TABLE dbo.Device_Capabilities (
    CapabilityId INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_Device_Capabilities PRIMARY KEY,
    DeviceTypeId INT NOT NULL,
    MetricId INT NOT NULL,
    CapabilityType NVARCHAR(30) NOT NULL CONSTRAINT DF_Device_Capabilities_CapabilityType DEFAULT (N'read'),
    ConfigJson NVARCHAR(MAX) NULL,
    CONSTRAINT FK_Device_Capabilities_Device_Types FOREIGN KEY (DeviceTypeId) REFERENCES dbo.Device_Types(DeviceTypeId),
    CONSTRAINT FK_Device_Capabilities_Metrics FOREIGN KEY (MetricId) REFERENCES dbo.Metrics(MetricId),
    CONSTRAINT UQ_Device_Capabilities UNIQUE (DeviceTypeId, MetricId, CapabilityType),
    CONSTRAINT CK_Device_Capabilities_Type CHECK (CapabilityType IN (N'read', N'write', N'event')),
    CONSTRAINT CK_Device_Capabilities_ConfigJson CHECK (ConfigJson IS NULL OR ISJSON(ConfigJson) = 1)
);
GO

/* 5. Generic readings: use the same table for temperature, humidity, people_count, etc. */
CREATE TABLE dbo.Telemetry (
    TelemetryId BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_Telemetry PRIMARY KEY,
    DeviceId INT NOT NULL,
    MetricId INT NOT NULL,
    ValueNumeric DECIMAL(18,6) NULL,
    ValueText NVARCHAR(1000) NULL,
    ValueJson NVARCHAR(MAX) NULL,
    RecordedAt DATETIME2(3) NOT NULL,
    ReceivedAt DATETIME2(3) NOT NULL CONSTRAINT DF_Telemetry_ReceivedAt DEFAULT (SYSUTCDATETIME()),
    MessageId NVARCHAR(100) NULL,
    CONSTRAINT FK_Telemetry_Devices FOREIGN KEY (DeviceId) REFERENCES dbo.Devices(DeviceId),
    CONSTRAINT FK_Telemetry_Metrics FOREIGN KEY (MetricId) REFERENCES dbo.Metrics(MetricId),
    CONSTRAINT CK_Telemetry_OneValue CHECK (
        (CASE WHEN ValueNumeric IS NULL THEN 0 ELSE 1 END) +
        (CASE WHEN ValueText IS NULL THEN 0 ELSE 1 END) +
        (CASE WHEN ValueJson IS NULL THEN 0 ELSE 1 END) = 1
    ),
    CONSTRAINT CK_Telemetry_ValueJson CHECK (ValueJson IS NULL OR ISJSON(ValueJson) = 1)
);
GO

CREATE INDEX IX_Telemetry_Device_Metric_RecordedAt
ON dbo.Telemetry(DeviceId, MetricId, RecordedAt DESC);
GO

CREATE INDEX IX_Telemetry_ReceivedAt
ON dbo.Telemetry(ReceivedAt DESC);
GO

/* 6. Historical state of actuators/devices, separate from connection status */
CREATE TABLE dbo.Device_States (
    StateId BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_Device_States PRIMARY KEY,
    DeviceId INT NOT NULL,
    StateCode NVARCHAR(100) NOT NULL,
    StateValue NVARCHAR(250) NOT NULL,
    RecordedAt DATETIME2(3) NOT NULL CONSTRAINT DF_Device_States_RecordedAt DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT FK_Device_States_Devices FOREIGN KEY (DeviceId) REFERENCES dbo.Devices(DeviceId)
);
GO

CREATE INDEX IX_Device_States_Device_RecordedAt
ON dbo.Device_States(DeviceId, RecordedAt DESC);
GO

/* 7. Users */
CREATE TABLE dbo.Users (
    UserId INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_Users PRIMARY KEY,
    UserName NVARCHAR(100) NOT NULL CONSTRAINT UQ_Users_UserName UNIQUE,
    PasswordHash NVARCHAR(255) NOT NULL,
    Role NVARCHAR(50) NOT NULL CONSTRAINT DF_Users_Role DEFAULT (N'viewer'),
    IsActive BIT NOT NULL CONSTRAINT DF_Users_IsActive DEFAULT (1),
    CONSTRAINT CK_Users_Role CHECK (Role IN (N'admin', N'operator', N'viewer'))
);
GO

/* 8. Commands sent to actuators/devices */
CREATE TABLE dbo.Commands (
    CommandId BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_Commands PRIMARY KEY,
    DeviceId INT NOT NULL,
    UserId INT NULL,
    CommandType NVARCHAR(100) NOT NULL,
    PayloadJson NVARCHAR(MAX) NULL,
    Status NVARCHAR(30) NOT NULL CONSTRAINT DF_Commands_Status DEFAULT (N'pending'),
    CreatedAt DATETIME2(3) NOT NULL CONSTRAINT DF_Commands_CreatedAt DEFAULT (SYSUTCDATETIME()),
    CompletedAt DATETIME2(3) NULL,
    CONSTRAINT FK_Commands_Devices FOREIGN KEY (DeviceId) REFERENCES dbo.Devices(DeviceId),
    CONSTRAINT FK_Commands_Users FOREIGN KEY (UserId) REFERENCES dbo.Users(UserId),
    CONSTRAINT CK_Commands_Status CHECK (Status IN (N'pending', N'sent', N'completed', N'failed', N'timeout', N'cancelled')),
    CONSTRAINT CK_Commands_PayloadJson CHECK (PayloadJson IS NULL OR ISJSON(PayloadJson) = 1)
);
GO

CREATE INDEX IX_Commands_Status_CreatedAt
ON dbo.Commands(Status, CreatedAt DESC);
GO

/* 9. Configurable alert rules and generated alerts */
CREATE TABLE dbo.Alert_Rules (
    RuleId INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_Alert_Rules PRIMARY KEY,
    MetricId INT NOT NULL,
    RoomId INT NULL,
    RuleName NVARCHAR(150) NOT NULL,
    Operator NVARCHAR(10) NOT NULL,
    Threshold DECIMAL(18,6) NULL,
    DurationSeconds INT NOT NULL CONSTRAINT DF_Alert_Rules_DurationSeconds DEFAULT (0),
    IsEnabled BIT NOT NULL CONSTRAINT DF_Alert_Rules_IsEnabled DEFAULT (1),
    ConfigJson NVARCHAR(MAX) NULL,
    CONSTRAINT FK_Alert_Rules_Metrics FOREIGN KEY (MetricId) REFERENCES dbo.Metrics(MetricId),
    CONSTRAINT FK_Alert_Rules_Rooms FOREIGN KEY (RoomId) REFERENCES dbo.Rooms(RoomId),
    CONSTRAINT CK_Alert_Rules_Operator CHECK (Operator IN (N'>', N'>=', N'<', N'<=', N'=', N'!=', N'changed')),
    CONSTRAINT CK_Alert_Rules_Duration CHECK (DurationSeconds >= 0),
    CONSTRAINT CK_Alert_Rules_ConfigJson CHECK (ConfigJson IS NULL OR ISJSON(ConfigJson) = 1)
);
GO

CREATE TABLE dbo.Alerts (
    AlertId BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_Alerts PRIMARY KEY,
    RoomId INT NULL,
    DeviceId INT NULL,
    ResolvedByUserId INT NULL,
    AlertType NVARCHAR(100) NOT NULL,
    Severity NVARCHAR(30) NOT NULL CONSTRAINT DF_Alerts_Severity DEFAULT (N'warning'),
    Message NVARCHAR(1000) NOT NULL,
    Status NVARCHAR(30) NOT NULL CONSTRAINT DF_Alerts_Status DEFAULT (N'open'),
    CreatedAt DATETIME2(3) NOT NULL CONSTRAINT DF_Alerts_CreatedAt DEFAULT (SYSUTCDATETIME()),
    ResolvedAt DATETIME2(3) NULL,
    CONSTRAINT FK_Alerts_Rooms FOREIGN KEY (RoomId) REFERENCES dbo.Rooms(RoomId),
    CONSTRAINT FK_Alerts_Devices FOREIGN KEY (DeviceId) REFERENCES dbo.Devices(DeviceId),
    CONSTRAINT FK_Alerts_ResolvedByUser FOREIGN KEY (ResolvedByUserId) REFERENCES dbo.Users(UserId),
    CONSTRAINT CK_Alerts_Severity CHECK (Severity IN (N'info', N'warning', N'critical')),
    CONSTRAINT CK_Alerts_Status CHECK (Status IN (N'open', N'acknowledged', N'resolved', N'closed'))
);
GO

CREATE INDEX IX_Alerts_Status_CreatedAt
ON dbo.Alerts(Status, CreatedAt DESC);
GO

/* 10. Audit trail */
CREATE TABLE dbo.Audit_Logs (
    AuditId BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_Audit_Logs PRIMARY KEY,
    UserId INT NULL,
    Action NVARCHAR(100) NOT NULL,
    EntityType NVARCHAR(100) NOT NULL,
    EntityId NVARCHAR(100) NULL,
    CreatedAt DATETIME2(3) NOT NULL CONSTRAINT DF_Audit_Logs_CreatedAt DEFAULT (SYSUTCDATETIME()),
    DetailsJson NVARCHAR(MAX) NULL,
    CONSTRAINT FK_Audit_Logs_Users FOREIGN KEY (UserId) REFERENCES dbo.Users(UserId),
    CONSTRAINT CK_Audit_Logs_DetailsJson CHECK (DetailsJson IS NULL OR ISJSON(DetailsJson) = 1)
);
GO

/* Seed configurable definitions; safe to re-run */
IF NOT EXISTS (SELECT 1 FROM dbo.Node_Types WHERE TypeName = N'ESP32')
    INSERT INTO dbo.Node_Types(TypeName) VALUES (N'ESP32');

IF NOT EXISTS (SELECT 1 FROM dbo.Device_Types WHERE TypeName = N'Temperature Sensor')
    INSERT INTO dbo.Device_Types(TypeName, Category) VALUES (N'Temperature Sensor', N'sensor');

IF NOT EXISTS (SELECT 1 FROM dbo.Device_Types WHERE TypeName = N'Humidity Sensor')
    INSERT INTO dbo.Device_Types(TypeName, Category) VALUES (N'Humidity Sensor', N'sensor');

IF NOT EXISTS (SELECT 1 FROM dbo.Device_Types WHERE TypeName = N'Air Quality Sensor')
    INSERT INTO dbo.Device_Types(TypeName, Category) VALUES (N'Air Quality Sensor', N'sensor');

IF NOT EXISTS (SELECT 1 FROM dbo.Device_Types WHERE TypeName = N'People Counter')
    INSERT INTO dbo.Device_Types(TypeName, Category) VALUES (N'People Counter', N'camera');

IF NOT EXISTS (SELECT 1 FROM dbo.Device_Types WHERE TypeName = N'Relay')
    INSERT INTO dbo.Device_Types(TypeName, Category) VALUES (N'Relay', N'actuator');

IF NOT EXISTS (SELECT 1 FROM dbo.Metrics WHERE MetricCode = N'temperature')
    INSERT INTO dbo.Metrics(MetricCode, DisplayName, DefaultUnit, DataType)
    VALUES (N'temperature', N'Temperature', N'°C', N'numeric');

IF NOT EXISTS (SELECT 1 FROM dbo.Metrics WHERE MetricCode = N'humidity')
    INSERT INTO dbo.Metrics(MetricCode, DisplayName, DefaultUnit, DataType)
    VALUES (N'humidity', N'Humidity', N'%', N'numeric');

IF NOT EXISTS (SELECT 1 FROM dbo.Metrics WHERE MetricCode = N'air_quality')
    INSERT INTO dbo.Metrics(MetricCode, DisplayName, DefaultUnit, DataType)
    VALUES (N'air_quality', N'Air Quality', NULL, N'numeric');

IF NOT EXISTS (SELECT 1 FROM dbo.Metrics WHERE MetricCode = N'people_count')
    INSERT INTO dbo.Metrics(MetricCode, DisplayName, DefaultUnit, DataType)
    VALUES (N'people_count', N'People Count', N'persons', N'numeric');

IF NOT EXISTS (SELECT 1 FROM dbo.Metrics WHERE MetricCode = N'smoke')
    INSERT INTO dbo.Metrics(MetricCode, DisplayName, DefaultUnit, DataType)
    VALUES (N'smoke', N'Smoke Level', NULL, N'numeric');

IF NOT EXISTS (SELECT 1 FROM dbo.Metrics WHERE MetricCode = N'light_intensity')
    INSERT INTO dbo.Metrics(MetricCode, DisplayName, DefaultUnit, DataType)
    VALUES (N'light_intensity', N'Light Intensity', N'lux', N'numeric');

PRINT 'CampusX schema created successfully (or was already present).';
GO