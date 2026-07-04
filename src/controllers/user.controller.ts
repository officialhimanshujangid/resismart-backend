import { Request, Response, RequestHandler } from 'express';
import { User } from '../models/user.model';

class AppError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/**
 * Get current user profile
 */
export const getMyProfile: RequestHandler = async (req, res, next) => {
  try {
    const userId = req.user?.userId;
    if (!userId) throw new AppError('Unauthorized', 401);

    const user = await User.findById(userId).select('-passwordHash');
    if (!user) throw new AppError('User not found', 404);

    res.status(200).json({ user });
  } catch (error) {
    next(error);
  }
};

/**
 * Update current user profile
 */
export const updateMyProfile: RequestHandler = async (req, res, next) => {
  try {
    const userId = req.user?.userId;
    if (!userId) throw new AppError('Unauthorized', 401);

    const { name, profileImage } = req.body;

    const user = await User.findById(userId);
    if (!user) throw new AppError('User not found', 404);

    if (name) user.name = name;
    if (profileImage !== undefined) user.profileImage = profileImage;

    await user.save();

    res.status(200).json({ 
      success: true, 
      user: {
        _id: user._id,
        name: user.name,
        email: user.email,
        profileImage: user.profileImage,
        isActive: user.isActive
      }
    });
  } catch (error) {
    next(error);
  }
};
