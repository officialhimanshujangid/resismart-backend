import { z } from 'zod';

const bankDetailsSchema = z.object({
  bankName: z.string().trim().optional(),
  accountNumber: z
    .string()
    .trim()
    .regex(/^[0-9]{9,18}$/, 'Bank account number must be between 9 and 18 digits')
    .optional()
    .or(z.literal('')),
  ifscCode: z
    .string()
    .trim()
    .regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'Invalid IFSC code format (e.g. SBIN0001234)')
    .optional()
    .or(z.literal('')),
}).optional();

const addressSchema = z.object({
  street: z.string().trim().optional(),
  city: z.string().trim().optional(),
  state: z.string().trim().optional(),
  zipCode: z
    .string()
    .trim()
    .regex(/^[0-9]{6}$/, 'Pincode must be exactly 6 digits')
    .optional()
    .or(z.literal('')),
  country: z.string().trim().optional(),
}).optional();

export const createSystemEmployeeSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters').trim(),
  email: z.string().email('Invalid email address').toLowerCase().trim(),
  password: z.string().min(6, 'Password must be at least 6 characters'),
  phone: z
    .string()
    .trim()
    .regex(/^[0-9]{10}$/, 'Phone number must be exactly 10 digits')
    .optional()
    .or(z.literal('')),
  designationId: z.string().min(1, 'Designation is required'),
  permissionRoleId: z.string().min(1, 'Permission role is required'),
  bankDetails: bankDetailsSchema,
  address: addressSchema,
  dateOfBirth: z.string().trim().optional().nullable(),
  dateOfJoining: z.string().trim().optional().nullable(),
  emergencyContact: z.string().trim().optional(),
  reportingManagerId: z.string().trim().optional().nullable(),
  profileImage: z.string().trim().optional().or(z.literal('')),
});

export const updateSystemEmployeeSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters').trim().optional(),
  phone: z
    .string()
    .trim()
    .regex(/^[0-9]{10}$/, 'Phone number must be exactly 10 digits')
    .optional()
    .or(z.literal('')),
  designationId: z.string().optional(),
  permissionRoleId: z.string().optional(),
  isActive: z.boolean().optional(),
  bankDetails: bankDetailsSchema,
  address: addressSchema,
  dateOfBirth: z.string().trim().optional().nullable(),
  dateOfJoining: z.string().trim().optional().nullable(),
  emergencyContact: z.string().trim().optional(),
  reportingManagerId: z.string().trim().optional().nullable(),
  profileImage: z.string().trim().optional().or(z.literal('')),
});

export type CreateSystemEmployeeInput = z.infer<typeof createSystemEmployeeSchema>;
export type UpdateSystemEmployeeInput = z.infer<typeof updateSystemEmployeeSchema>;
