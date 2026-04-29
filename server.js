const express = require("express");
const dotenv = require("dotenv");
const swaggerUi = require("swagger-ui-express");
const { S3Client, ListObjectsV2Command } = require("@aws-sdk/client-s3");

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

const rawMaxDays = Number.parseInt(process.env.MAX_RANGE_DAYS || "365", 10);
const MAX_RANGE_DAYS = Number.isFinite(rawMaxDays) && rawMaxDays > 0 ? rawMaxDays : 365;
const MAX_RANGE_MS = MAX_RANGE_DAYS * 24 * 60 * 60 * 1000;

const openapiDocument = require("./openapi.json");

const requiredEnvVars = ["AWS_REGION", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "S3_BUCKET_NAME"];
const missingVars = requiredEnvVars.filter((key) => !process.env[key]);

if (missingVars.length > 0) {
  console.error(`Missing required environment variables: ${missingVars.join(", ")}`);
  process.exit(1);
}

const s3Client = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const isValidDate = (value) => {
  const date = new Date(value);
  return !Number.isNaN(date.getTime());
};

/**
 * Date-only end (no "T") is end of that calendar day UTC so e.g. 2026-04-30 includes the full day.
 */
const parseEndDate = (endDate) => {
  const end = new Date(endDate);
  if (Number.isNaN(end.getTime())) {
    return null;
  }
  const asString = typeof endDate === "string" ? endDate : String(endDate);
  if (!asString.includes("T")) {
    end.setUTCHours(23, 59, 59, 999);
  }
  return end;
};

const normalizeFolderPrefix = (folderName) => {
  if (!folderName || typeof folderName !== "string") {
    return undefined;
  }

  const trimmed = folderName.trim().replace(/^\/+|\/+$/g, "");
  if (!trimmed) {
    return undefined;
  }

  return `${trimmed}/`;
};

const escapeCsvField = (value) => {
  const s = value == null ? "" : String(value);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
};

const formatDateToIst = (value) => {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  const parts = new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const get = (type) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("day")}-${get("month")}-${get("year")} ${get("hour")}:${get("minute")}:${get("second")} IST`;
};

const buildFilesCsv = (rows) => {
  const header = "fileName,uploadedAt";
  const lines = [
    header,
    ...rows.map((r) => {
      const uploaded = formatDateToIst(r.uploadedAt);
      return `${escapeCsvField(r.fileName)},${escapeCsvField(uploaded)}`;
    }),
  ];
  return lines.join("\r\n");
};

const safeFilenamePart = (s) => String(s).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-|-$/g, "") || "file";

const listAllObjects = async (bucketName, prefix) => {
  const allObjects = [];
  let continuationToken;

  do {
    const command = new ListObjectsV2Command({
      Bucket: bucketName,
      Prefix: prefix || undefined,
      ContinuationToken: continuationToken,
    });

    const response = await s3Client.send(command);
    if (response.Contents) {
      allObjects.push(...response.Contents);
    }
    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken);

  return allObjects;
};

const getFilteredFilesResult = async ({ startDate, endDate, folderName }) => {
  if (!startDate || !endDate) {
    return {
      error: {
        status: 400,
        body: {
          message: "Both startDate and endDate query parameters are required.",
          example: "/files?startDate=2026-04-01&endDate=2026-04-30",
        },
      },
    };
  }

  if (!isValidDate(startDate) || !isValidDate(endDate)) {
    return {
      error: {
        status: 400,
        body: {
          message: "Invalid date format. Use ISO format like 2026-04-01 or 2026-04-01T00:00:00Z.",
        },
      },
    };
  }

  const start = new Date(startDate);
  const end = parseEndDate(endDate);

  if (!end) {
    return {
      error: {
        status: 400,
        body: {
          message: "Invalid endDate.",
        },
      },
    };
  }

  if (start > end) {
    return {
      error: {
        status: 400,
        body: {
          message: "startDate must be earlier than or equal to endDate.",
        },
      },
    };
  }

  const diffMs = end.getTime() - start.getTime();
  if (diffMs > MAX_RANGE_MS) {
    return {
      error: {
        status: 400,
        body: {
          message: `Date range cannot exceed ${MAX_RANGE_DAYS} days.`,
          maxRangeDays: MAX_RANGE_DAYS,
        },
      },
    };
  }

  const folderPrefix = normalizeFolderPrefix(folderName);
  const objects = await listAllObjects(process.env.S3_BUCKET_NAME, folderPrefix);
  const s3ObjectsListed = objects.length;

  const files = objects
    .filter((obj) => obj.LastModified && obj.LastModified >= start && obj.LastModified <= end)
    .map((obj) => ({
      fileName: obj.Key,
      uploadedAt: obj.LastModified,
    }))
    .sort((a, b) => new Date(a.uploadedAt) - new Date(b.uploadedAt));

  return {
    data: {
      bucket: process.env.S3_BUCKET_NAME,
      folderPrefix: folderPrefix || null,
      dateRange: {
        startDate: start.toISOString(),
        endDate: end.toISOString(),
      },
      s3ObjectsListed,
      count: files.length,
      files,
    },
  };
};

app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(openapiDocument));

app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

app.get("/files", async (req, res) => {
  try {
    const result = await getFilteredFilesResult(req.query);
    if (result.error) {
      return res.status(result.error.status).json(result.error.body);
    }
    const payload = result.data;

    console.log(
      `[GET /files] ok bucket=${payload.bucket} folder=${payload.folderPrefix ?? "(entire bucket)"} s3ObjectsListed=${payload.s3ObjectsListed} matchedInDateRange=${payload.count} start=${payload.dateRange.startDate} end=${payload.dateRange.endDate}`
    );

    const csvBody = `\uFEFF${buildFilesCsv(payload.files)}`;
    const fn = `s3-files-${safeFilenamePart(payload.bucket)}-${payload.dateRange.startDate.slice(0, 10)}_to_${payload.dateRange.endDate.slice(0, 10)}.csv`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${fn}"`);
    return res.status(200).send(csvBody);
  } catch (error) {
    console.error("Error listing files from S3:", error);
    return res.status(500).json({
      message: "Failed to fetch files from S3. Check credentials, bucket name, and permissions.",
      error: error.message,
    });
  }
});

app.get("/files/preview", async (req, res) => {
  try {
    const result = await getFilteredFilesResult(req.query);
    if (result.error) {
      return res.status(result.error.status).json(result.error.body);
    }

    const payload = result.data;
    console.log(
      `[GET /files/preview] ok bucket=${payload.bucket} folder=${payload.folderPrefix ?? "(entire bucket)"} s3ObjectsListed=${payload.s3ObjectsListed} matchedInDateRange=${payload.count} start=${payload.dateRange.startDate} end=${payload.dateRange.endDate}`
    );

    return res.status(200).json(payload);
  } catch (error) {
    console.error("Error previewing files from S3:", error);
    return res.status(500).json({
      message: "Failed to fetch files from S3. Check credentials, bucket name, and permissions.",
      error: error.message,
    });
  }
});

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
