/* Optional manual migration. The Node.js startup initializer creates and upgrades this table automatically. */
IF OBJECT_ID(N'dbo.DashboardAccounts', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.DashboardAccounts (
        AccountId INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_DashboardAccounts PRIMARY KEY,
        Username NVARCHAR(64) NOT NULL,
        PasswordHash NVARCHAR(300) NOT NULL,
        Email NVARCHAR(320) NULL,
        FullName NVARCHAR(100) NULL,
        Role NVARCHAR(20) NOT NULL CONSTRAINT DF_DashboardAccounts_Role DEFAULT (N'user')
            CONSTRAINT CK_DashboardAccounts_Role CHECK (Role IN (N'user', N'admin')),
        EmailVerifiedAt DATETIME2 NULL,
        PendingEmail NVARCHAR(320) NULL,
        EmailVerificationTokenHash CHAR(64) NULL,
        EmailVerificationExpiresAt DATETIME2 NULL,
        SessionVersion INT NOT NULL CONSTRAINT DF_DashboardAccounts_SessionVersion DEFAULT (1),
        CreatedAt DATETIME2 NOT NULL CONSTRAINT DF_DashboardAccounts_CreatedAt DEFAULT SYSUTCDATETIME(),
        UpdatedAt DATETIME2 NOT NULL CONSTRAINT DF_DashboardAccounts_UpdatedAt DEFAULT SYSUTCDATETIME(),
        LastLoginAt DATETIME2 NULL,
        CONSTRAINT UQ_DashboardAccounts_Username UNIQUE (Username)
    );
    CREATE UNIQUE INDEX UX_DashboardAccounts_Email
        ON dbo.DashboardAccounts(Email) WHERE Email IS NOT NULL;
END;
ELSE
BEGIN
    IF COL_LENGTH(N'dbo.DashboardAccounts', N'Email') IS NULL
        ALTER TABLE dbo.DashboardAccounts ADD Email NVARCHAR(320) NULL;
    IF COL_LENGTH(N'dbo.DashboardAccounts', N'FullName') IS NULL
        ALTER TABLE dbo.DashboardAccounts ADD FullName NVARCHAR(100) NULL;
    IF COL_LENGTH(N'dbo.DashboardAccounts', N'Role') IS NULL
        ALTER TABLE dbo.DashboardAccounts ADD Role NVARCHAR(20) NOT NULL
            CONSTRAINT DF_DashboardAccounts_Role DEFAULT (N'user');
END;
GO

IF COL_LENGTH(N'dbo.DashboardAccounts', N'Role') IS NOT NULL
   AND NOT EXISTS (
       SELECT 1 FROM sys.check_constraints
       WHERE parent_object_id = OBJECT_ID(N'dbo.DashboardAccounts') AND name = N'CK_DashboardAccounts_Role'
   )
    ALTER TABLE dbo.DashboardAccounts ADD CONSTRAINT CK_DashboardAccounts_Role
        CHECK (Role IN (N'user', N'admin'));
GO

IF COL_LENGTH(N'dbo.DashboardAccounts', N'Email') IS NOT NULL
   AND NOT EXISTS (
       SELECT 1 FROM sys.indexes
       WHERE object_id = OBJECT_ID(N'dbo.DashboardAccounts') AND name = N'UX_DashboardAccounts_Email'
   )
    CREATE UNIQUE INDEX UX_DashboardAccounts_Email
        ON dbo.DashboardAccounts(Email) WHERE Email IS NOT NULL;
GO

/* Set the first administrator explicitly if needed:
   UPDATE dbo.DashboardAccounts SET Role = N'admin' WHERE Username = N'your-admin-username';
   The backend also promotes the bootstrap account when no admin exists. */
