import express, { Request, Response } from "express";
import dotenv from "dotenv";
import mongoose from "mongoose";
import { z } from "zod";
import React from "react";
import ReactDOMServer from "react-dom/server";
import { Resend } from "resend";
import { EmailTemplate } from "../components/email-template"; // adjust path if needed

dotenv.config();

const router = express.Router();

/* ------------------------- MongoDB Connection ------------------------- */
if (!mongoose.connection.readyState) {
  mongoose
    .connect(process.env.MONGODB_URI as string)
    .then(() => console.log("✅ Connected to MongoDB"))
    .catch((err: unknown) => console.error("❌ MongoDB connection error:", err));
}

/* ----------------------------- Mongoose Model ----------------------------- */
const subscriberSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    role: { type: String, enum: ["provider", "customer"], required: true },
    joinedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

const Subscriber = mongoose.model("Subscriber", subscriberSchema);

/* ------------------------- Resend Setup ------------------------- */
const resend = new Resend(process.env.RESEND_API_KEY);

/* --------------------------- Validation Schema --------------------------- */
const schema = z.object({
  name: z.string().min(1, "Name is required"),
  email: z.string().email("Invalid email address"),
  role: z.enum(["customer", "provider"], {
    required_error: "Role is required",
  }),
});

/* ---------------------------- POST /join ---------------------------- */
router.post("/join", async (req: Request, res: Response) => {
  try {
    const { name, email, role } = schema.parse(req.body);

    // Check for duplicates
    const existing = await Subscriber.findOne({ email });
    if (existing) {
      return res.status(409).json({
        success: false,
        message: "This email is already on the waitlist",
      });
    }

    // Render React email template to HTML
    const emailHTML = ReactDOMServer.renderToStaticMarkup(
      React.createElement(EmailTemplate, { name, email })
    );

    // Try sending welcome email via Resend
    try {
      await resend.emails.send({
        from: "no-reply@steerifygroup.com",
        to: email,
        subject: "Welcome to Steerify Waitlist! 🎉",
        html: emailHTML,
      });

      console.log(`✅ Welcome email sent to ${email}`);
    } catch (mailError: any) {
      console.error("❌ Email sending failed:", mailError);
      return res.status(500).json({
        success: false,
        message:
          "Failed to send confirmation email. Please try again later.",
      });
    }

    // Save subscriber only if email sent successfully
    const newSubscriber = await Subscriber.create({ name, email, role });
    const count = await Subscriber.countDocuments();

    res.json({
      success: true,
      message:
        "You have been added to the waitlist! Check your email for confirmation.",
      count,
      subscriber: newSubscriber,
    });
  } catch (error: any) {
    console.error("❌ Error joining waitlist:", error);
    res.status(500).json({
      success: false,
      message: error.message || "An unexpected error occurred.",
    });
  }
});

/* ---------------------------- GET /count ---------------------------- */
router.get("/count", async (_req: Request, res: Response) => {
  try {
    const count = await Subscriber.countDocuments();
    res.json({ success: true, count });
  } catch (error) {
    console.error("Error getting waitlist count:", error);
    res.json({ success: false, count: 0 });
  }
});

/* ------------------------- GET /subscribers ------------------------- */
router.get("/subscribers", async (_req: Request, res: Response) => {
  try {
    const subscribers = await Subscriber.find().sort({ createdAt: -1 });
    res.json({ success: true, subscribers });
  } catch (error) {
    console.error("Error fetching subscribers:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching subscribers",
      subscribers: [],
    });
  }
});

/* ---------------------- DELETE /subscriber/:email ---------------------- */
router.delete("/subscriber/:email", async (req: Request, res: Response) => {
  try {
    const { email } = req.params;

    const deleted = await Subscriber.findOneAndDelete({ email });

    if (!deleted) {
      return res.status(404).json({
        success: false,
        message: "Subscriber not found",
      });
    }

    const count = await Subscriber.countDocuments();

    res.json({
      success: true,
      message: "Subscriber deleted successfully",
      count,
    });
  } catch (error) {
    console.error("Error deleting subscriber:", error);
    res.status(500).json({
      success: false,
      message: "Error deleting subscriber",
    });
  }
});

/* ------------------------- POST /bulk-email ------------------------- */
router.post("/bulk-email", async (req: Request, res: Response) => {
  const { subject, body, emails } = req.body;

  console.log("🧾 Bulk email request body:", req.body);

  if (!subject || !body || !emails || !Array.isArray(emails) || emails.length === 0) {
    return res.status(400).json({
      success: false,
      message: "Subject, body, and at least one recipient are required.",
    });
  }

  try {
    const results = await Promise.allSettled(
      emails.map(async (email: string) => {
        console.log(`📤 Sending to ${email}...`);
        await resend.emails.send({
          from: "no-reply@steerifygroup.com",
          to: email,
          subject,
          html: `<div style="font-family:sans-serif;line-height:1.6;">${body.replace(
            /\n/g,
            "<br/>"
          )}</div>`,
        });
        console.log(`✅ Sent to ${email}`);
        return { email, success: true };
      })
    );

    const failed = results.filter(
      (r) => r.status === "rejected" || (r as any).value?.success === false
    );

    if (failed.length > 0) {
      console.error("❌ Failed emails:", failed);
      return res.status(500).json({
        success: false,
        message: `Failed to send to: ${failed
          .map((f: any) => f.reason?.email || f.email)
          .join(", ")}`,
      });
    }

    res.json({
      success: true,
      message: `Emails sent successfully to ${emails.length} subscriber(s).`,
    });
  } catch (err) {
    console.error("Bulk email error:", err);
    res.status(500).json({
      success: false,
      message: "An error occurred while sending bulk emails.",
      error: err,
    });
  }
});

export default router;
