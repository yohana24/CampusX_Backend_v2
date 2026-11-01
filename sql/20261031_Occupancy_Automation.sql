USE CampusX;
GO

IF COL_LENGTH('dbo.Commands', 'RequestedBy') IS NULL
BEGIN
    ALTER TABLE dbo.Commands ADD RequestedBy NVARCHAR(100) NULL;
END;
GO

IF OBJECT_ID(N'dbo.Occupancy_Automation_Settings', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.Occupancy_Automation_Settings (
        RoomId INT NOT NULL CONSTRAINT PK_Occupancy_Automation_Settings PRIMARY KEY,
        IsEnabled BIT NOT NULL CONSTRAINT DF_Occupancy_Automation_IsEnabled DEFAULT (0),
        PersonThreshold INT NOT NULL CONSTRAINT DF_Occupancy_Automation_PersonThreshold DEFAULT (3),
        OffDelaySeconds INT NOT NULL CONSTRAINT DF_Occupancy_Automation_OffDelay DEFAULT (30),
        RestoreOnAboveThreshold BIT NOT NULL CONSTRAINT DF_Occupancy_Automation_Restore DEFAULT (1),
        FanDeviceCode NVARCHAR(100) NULL,
        LightDeviceCode NVARCHAR(100) NULL,
        CandidateState NVARCHAR(10) NULL,
        CandidateSince DATETIME2(3) NULL,
        LastObservedCount INT NULL,
        LastActionMessage NVARCHAR(250) NULL,
        LastActionAt DATETIME2(3) NULL,
        UpdatedAt DATETIME2(3) NOT NULL CONSTRAINT DF_Occupancy_Automation_UpdatedAt DEFAULT (SYSUTCDATETIME()),
        CONSTRAINT FK_Occupancy_Automation_Rooms FOREIGN KEY (RoomId) REFERENCES dbo.Rooms(RoomId),
        CONSTRAINT CK_Occupancy_Automation_Threshold CHECK (PersonThreshold BETWEEN 0 AND 500),
        CONSTRAINT CK_Occupancy_Automation_Delay CHECK (OffDelaySeconds BETWEEN 5 AND 3600),
        CONSTRAINT CK_Occupancy_Automation_Candidate CHECK (CandidateState IS NULL OR CandidateState IN (N'on', N'off'))
    );
END;
GO

PRINT 'CampusX occupancy automation schema is ready. New automations remain disabled until enabled in Control Panel.';
GO
