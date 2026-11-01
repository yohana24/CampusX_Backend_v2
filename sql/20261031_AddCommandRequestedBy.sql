/* CampusX command sender tracking migration. Safe to execute more than once. */
IF OBJECT_ID(N'dbo.Commands', N'U') IS NULL
    THROW 50001, 'dbo.Commands does not exist. Run the CampusX database setup first.', 1;
GO

IF COL_LENGTH(N'dbo.Commands', N'RequestedBy') IS NULL
BEGIN
    ALTER TABLE dbo.Commands ADD RequestedBy NVARCHAR(100) NULL;
END;
GO

/* Backfill older commands where UserId maps to the legacy dbo.Users table. */
IF OBJECT_ID(N'dbo.Users', N'U') IS NOT NULL
BEGIN
    UPDATE c
      SET c.RequestedBy = u.UserName
    FROM dbo.Commands AS c
    INNER JOIN dbo.Users AS u ON u.UserId = c.UserId
    WHERE c.RequestedBy IS NULL;
END;
GO
