import multer from 'multer';
import { Request } from 'express';

// Setup memory storage to hold file in buffer before uploading to S3
const storage = multer.memoryStorage();

// File filter to allow only images
const fileFilter = (req: Request, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  if (file.mimetype.startsWith('image/')) {
    cb(null, true);
  } else {
    cb(new Error('Invalid file type. Only images are allowed!') as any, false);
  }
};

// Multer upload configuration
export const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit
  },
});

// File filter to allow excel files
const excelFileFilter = (req: Request, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  if (
    file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    file.mimetype === 'application/vnd.ms-excel'
  ) {
    cb(null, true);
  } else {
    cb(new Error('Invalid file type. Only Excel files are allowed!') as any, false);
  }
};

export const uploadExcel = multer({
  storage,
  fileFilter: excelFileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  },
});

/**
 * Spreadsheets for bulk import: Excel AND CSV.
 *
 * Separate from `uploadExcel` rather than widening it — that filter guards the
 * flats bulk-upload route, and loosening what it accepts would change behaviour
 * somewhere nobody was looking. CSV is the realistic export from Tally and from
 * every bank portal, so refusing it would send people back to Excel to re-save.
 * Browsers disagree on the CSV mimetype (some say text/plain, Windows says
 * application/vnd.ms-excel), so the extension is the tiebreaker.
 */
const spreadsheetFileFilter = (req: Request, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  const ok =
    file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    file.mimetype === 'application/vnd.ms-excel' ||
    file.mimetype === 'text/csv' ||
    file.mimetype === 'application/csv' ||
    file.mimetype === 'text/plain' ||
    /\.(xlsx|xls|csv)$/i.test(file.originalname);
  if (ok) {
    cb(null, true);
  } else {
    cb(new Error('Invalid file type. Upload an Excel (.xlsx, .xls) or CSV file!') as any, false);
  }
};

export const uploadSpreadsheet = multer({
  storage,
  fileFilter: spreadsheetFileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  },
});

// Documents (resident ID proof, rental agreement, police verification): PDF + images.
const documentFileFilter = (req: Request, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  if (file.mimetype === 'application/pdf' || file.mimetype.startsWith('image/')) {
    cb(null, true);
  } else {
    cb(new Error('Invalid file type. Only PDF or image documents are allowed!') as any, false);
  }
};

export const uploadDocument = multer({
  storage,
  fileFilter: documentFileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  },
});
