import { Request, Response } from 'express';
import { Society } from '../models/society.model';
import { Shop } from '../models/shop.model';
import { Invoice } from '../models/invoice.model';
import { Subscription } from '../models/subscription.model';

export class DashboardController {
  static async getOwnerMetrics(req: Request, res: Response) {
    try {
      // Basic counts
      const [totalSocieties, totalShops, totalInvoices, paidInvoices] = await Promise.all([
        Society.countDocuments({ isDeleted: { $ne: true } }),
        Shop.countDocuments({ isDeleted: { $ne: true } }),
        Invoice.countDocuments({ isDeleted: { $ne: true } }),
        Invoice.countDocuments({ isDeleted: { $ne: true }, status: 'PAID' })
      ]);

      // Total revenue (sum of amount for PAID invoices)
      const revenueAgg = await Invoice.aggregate([
        { $match: { isDeleted: { $ne: true }, status: 'PAID' } },
        { $group: { _id: null, total: { $sum: '$amount' } } }
      ]);
      const totalRevenue = revenueAgg[0]?.total || 0;

      // Recent Orders (Recent 5 invoices)
      const recentOrders = await Invoice.find({ isDeleted: { $ne: true } })
        .sort({ createdAt: -1 })
        .limit(5)
        .lean();

      for (const order of recentOrders) {
        if (order.tenantType === 'SOCIETY') {
          order.tenantId = await Society.findById(order.tenantId, 'name email contactEmail').lean() as any;
        } else if (order.tenantType === 'SHOP') {
          order.tenantId = await Shop.findById(order.tenantId, 'name email contactEmail').lean() as any;
        }
      }

      // Chart Data: Revenue per month for the last 12 months
      const twelveMonthsAgo = new Date();
      twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 11);
      twelveMonthsAgo.setDate(1);
      twelveMonthsAgo.setHours(0, 0, 0, 0);

      const monthlyRevenue = await Invoice.aggregate([
        { 
          $match: { 
            isDeleted: { $ne: true }, 
            status: 'PAID',
            paidAt: { $gte: twelveMonthsAgo }
          }
        },
        {
          $group: {
            _id: { 
              year: { $year: "$paidAt" }, 
              month: { $month: "$paidAt" } 
            },
            revenue: { $sum: "$amount" }
          }
        },
        { $sort: { "_id.year": 1, "_id.month": 1 } }
      ]);

      // Format chart data
      const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      const chartData = [];
      const d = new Date(twelveMonthsAgo);
      for (let i = 0; i < 12; i++) {
        const y = d.getFullYear();
        const m = d.getMonth() + 1; // 1-12
        const agg = monthlyRevenue.find(x => x._id.year === y && x._id.month === m);
        chartData.push({
          name: monthNames[d.getMonth()],
          revenue: agg ? Math.round(agg.revenue / 100) : 0, // Assuming amount is in paise
        });
        d.setMonth(d.getMonth() + 1);
      }

      return res.status(200).json({
        success: true,
        metrics: {
          totalSocieties,
          totalShops,
          totalCustomers: totalSocieties + totalShops,
          totalInvoices,
          paidInvoices,
          totalRevenuePaise: totalRevenue,
          recentOrders,
          chartData,
        }
      });
    } catch (error: any) {
      return res.status(500).json({ success: false, message: error.message });
    }
  }
}
