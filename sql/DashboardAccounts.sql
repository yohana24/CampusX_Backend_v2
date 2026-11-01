/* Optional manual migration. The Node.js startup initializer creates this table automatically. */
IF OBJECT_ID(N'dbo.DashboardAccounts', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.DashboardAccounts (
        AccountId INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_DashboardAccounts PRIMARY KEY,
        Username NVARCHAR(64) NOT NULL,
        PasswordHash NVARCHAR(300) NOT NULL,
        Email NVARCHAR(320) NULL,
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
