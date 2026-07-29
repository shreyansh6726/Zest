require('dotenv').config();
const express = require('express');

const cors = require('cors');
const { exec, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const SibApiV3Sdk = require('sib-api-v3-sdk');
const Student = require('./models/Student');
const OTP = require('./models/OTP');
const Exam = require('./models/Exam');
const TestContent = require('./models/TestContent');
const Notification = require('./models/Notification');
const Batch = require('./models/Batch');
const nodeSchedule = require('node-schedule');

const app = express();
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const cookieSession = require('cookie-session');
const server = http.createServer(app);
app.set('trust proxy', 1);

// In-memory storage for active users
const activeUsers = new Map(); // email -> { name, email, lastActive, socketId }

// --- MongoDB Connection ---
const MONGO_URI = process.env.MONGO_URI;
mongoose.connect(MONGO_URI)
    .then(() => {
        console.log('Connected to MongoDB (Zest)');
        initExamSchedules();
    })
    .catch(err => console.error('MongoDB connection error:', err));

// --- Brevo Config ---
console.log('[Auth] Brevo Config Check:', {
    hasApiKey: !!process.env.BREVO_API_KEY,
    fromEmail: process.env.BREVO_FROM_EMAIL || process.env.EMAIL_USER
});

const defaultClient = SibApiV3Sdk.ApiClient.instance;
const apiKey = defaultClient.authentications['api-key'];
apiKey.apiKey = process.env.BREVO_API_KEY;
const apiInstance = new SibApiV3Sdk.TransactionalEmailsApi();
const brevoSenderEmail = (process.env.BREVO_FROM_EMAIL || process.env.EMAIL_USER || '').trim();


const io = new Server(server, {
    cors: {
        origin: '*', // Adjust for production
        methods: ['GET', 'POST']
    }
});

app.use(cors({
    origin: true,
    credentials: true
}));
app.options(/.*/, cors({
    origin: true,
    credentials: true
}));

app.use(cookieSession({
    name: 'session',
    keys: [process.env.JWT_SECRET || 'zest_secret'],
    maxAge: 24 * 60 * 60 * 1000,
    sameSite: 'none',
    secure: true
}));

app.use(passport.initialize());
app.use(passport.session());

passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: process.env.GOOGLE_CALLBACK_URL,
    proxy: true
},
    async (accessToken, refreshToken, profile, done) => {
        try {
            console.log('[Auth] Google Profile Received:', JSON.stringify(profile, null, 2));

            if (!profile.emails || profile.emails.length === 0) {
                console.error('[Auth] No emails found in Google profile');
                return done(new Error('No email found in Google account'), null);
            }

            const email = profile.emails[0].value;
            const profilePicture = profile.photos && profile.photos.length > 0 ? profile.photos[0].value : '';
            
            let user = await Student.findOne({ emailID: email });

            if (!user) {
                console.log(`[Auth] Creating new student: ${email}`);
                user = new Student({
                    name: profile.displayName || 'Google User',
                    emailID: email,
                    password: null,
                    profilePicture: profilePicture
                });
                await user.save();
            } else {
                console.log(`[Auth] Existing student found: ${email}`);
                if (profilePicture && user.profilePicture !== profilePicture) {
                    user.profilePicture = profilePicture;
                    await user.save();
                }
            }

            return done(null, user);
        } catch (err) {
            console.error('[Auth] Google Strategy Error Details:', err);
            return done(err, null);
        }
    }
));

passport.serializeUser((user, done) => {
    done(null, user.id);
});

passport.deserializeUser(async (id, done) => {
    try {
        const user = await Student.findById(id);
        done(null, user);
    } catch (err) {
        done(err, null);
    }
});
app.use(express.json());
app.use(express.text());

const TEMP_DIR = path.join(__dirname, 'temp');

if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR);
}

const normalizeBatchSlug = (value) => String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const buildBatchFilter = (batchId) => {
    if (!batchId) {
        return {};
    }
    return { batchId };
};

const formatBatchForClient = (batch) => batch ? {
    _id: batch._id,
    name: batch.name,
    slug: batch.slug,
    isActive: batch.isActive,
    createdAt: batch.createdAt,
    updatedAt: batch.updatedAt
} : null;

const getStudentBatchResponse = async (student) => {
    if (!student) {
        return null;
    }

    let batch = null;
    if (student.batchId) {
        batch = await Batch.findById(student.batchId);
    }

    return {
        name: student.name,
        email: student.emailID,
        dp: student.profilePicture || '',
        batchId: student.batchId || null,
        batch: formatBatchForClient(batch)
    };
};

const getBatchFromRequest = async (batchId) => {
    if (!batchId) {
        return null;
    }
    return Batch.findById(batchId);
};

// Helper to extract public class name
const getClassName = (code) => {
    const match = code.match(/public\s+class\s+([a-zA-Z0-9_$]+)/);
    return match ? match[1] : 'Main';
};

const normalizeQuestion = (question, index) => ({
    questionNo: Number.isFinite(Number(question?.questionNo)) ? Number(question.questionNo) : index + 1,
    ques: question?.ques || '',
    type: question?.type,
    options: ['single option answer', 'multiple option answer'].includes(question?.type)
        ? (question?.options || [])
        : [],
    testCases: question?.type === 'write code answer'
        ? (question?.testCases || [])
        : [],
    marks: Number(question?.marks) || 0,
    answerKey: question?.answerKey
});

const normalizeQuestions = (questions = []) => questions.map((question, index) => normalizeQuestion(question, index));

const serializeStudentAnswer = (studentAnswer) => {
    if (Array.isArray(studentAnswer)) return [...studentAnswer];
    if (studentAnswer === undefined || studentAnswer === null) return null;
    return String(studentAnswer);
};

const formatStudentAnswerForStorage = (studentAnswer) => {
    if (Array.isArray(studentAnswer)) {
        return studentAnswer.map((item) => String(item)).join(', ');
    }
    if (studentAnswer === undefined || studentAnswer === null) {
        return '';
    }
    return String(studentAnswer);
};

const compareAnswers = (question, studentAnswer, codeResult) => {
    switch (question.type) {
        case 'single option answer':
            return String(studentAnswer ?? '').trim() === String(question.answerKey ?? '').trim();
        case 'multiple option answer': {
            const correctArr = Array.isArray(question.answerKey) ? [...question.answerKey].sort() : [];
            const studentArr = Array.isArray(studentAnswer) ? [...studentAnswer].sort() : [];
            return JSON.stringify(correctArr) === JSON.stringify(studentArr);
        }
        case 'value enter answer':
            return String(studentAnswer ?? '').trim().toLowerCase() === String(question.answerKey ?? '').trim().toLowerCase();
        case 'write code answer':
            return Boolean(codeResult?.compiled) && Boolean(codeResult?.allPassed);
        default:
            return false;
    }
};

const upsertWrongAnswerRecord = async ({ student, testId, question, studentAnswer, codeResult }) => {
    if (!student || !testId || !question?._id) return null;

    const isCorrect = compareAnswers(question, studentAnswer, codeResult);
    if (isCorrect) return null;

    student.wrongAnswers = Array.isArray(student.wrongAnswers) ? student.wrongAnswers : [];
    const wrongAttempt = {
        testId,
        questionId: question._id,
        questionNo: Number(question.questionNo) || null,
        answer: formatStudentAnswerForStorage(studentAnswer),
        recordedAt: new Date()
    };

    const attemptIndex = student.wrongAnswers.findIndex(
        (attempt) => String(attempt.testId) === String(testId) && String(attempt.questionId) === String(question._id)
    );

    if (attemptIndex >= 0) {
        student.wrongAnswers[attemptIndex] = {
            ...student.wrongAnswers[attemptIndex].toObject?.(),
            ...wrongAttempt
        };
    } else {
        student.wrongAnswers.push(wrongAttempt);
    }

    return student.save();
};

const storeYellowWarningCount = async ({ student, testId, yellowWarningCount }) => {
    if (!student || !testId || !Number.isFinite(Number(yellowWarningCount))) return null;

    const count = Math.max(0, Number(yellowWarningCount));
    student.yellowWarning = Array.isArray(student.yellowWarning) ? student.yellowWarning : [];
    student.activeYellowWarningByTest = student.activeYellowWarningByTest || new Map();
    student.yellowWarning.push(count);
    student.activeYellowWarningByTest.delete(testId);
    return student.save();
};

// Helper: Run Java code against test cases and return results
const runJavaTestCases = (code, testCases) => {
    return new Promise((resolve) => {
        if (!code || !testCases || testCases.length === 0) {
            return resolve({ compiled: false, allPassed: false, results: [] });
        }
        const className = getClassName(code);
        const sessionId = uuidv4();
        const sessionDir = path.join(TEMP_DIR, sessionId);
        fs.mkdirSync(sessionDir);

        const javaFile = path.join(sessionDir, `${className}.java`);
        fs.writeFileSync(javaFile, code);

        exec(`javac "${className}.java"`, { cwd: sessionDir }, async (compileErr, stdout, stderr) => {
            if (compileErr || stderr) {
                fs.rmSync(sessionDir, { recursive: true, force: true });
                return resolve({ compiled: false, allPassed: false, error: stderr || compileErr.message, results: [] });
            }

            const results = [];
            let allPassed = true;

            for (const tc of testCases) {
                const tcResult = await new Promise((tcResolve) => {
                    const child = spawn('java', [className], { cwd: sessionDir });
                    let output = '';
                    let timedOut = false;

                    const timer = setTimeout(() => {
                        timedOut = true;
                        child.kill();
                    }, 5000);

                    child.stdout.on('data', (data) => { output += data.toString(); });
                    child.stderr.on('data', (data) => { output += data.toString(); });

                    if (tc.input) child.stdin.write(tc.input);
                    child.stdin.end();

                    child.on('close', () => {
                        clearTimeout(timer);
                        const actualOutput = output.trim();
                        const expectedOutput = (tc.output || '').trim();
                        const passed = !timedOut && actualOutput === expectedOutput;
                        if (!passed) allPassed = false;
                        tcResolve({ input: tc.input, expectedOutput, actualOutput, passed, timedOut });
                    });
                });
                results.push(tcResult);
            }

            fs.rmSync(sessionDir, { recursive: true, force: true });
            resolve({ compiled: true, allPassed, results });
        });
    });
};

// Helper to parse custom ddmmyyyy and hhmmss into Date object
const parseExamDate = (ddmmyyyy, hhmmss) => {
    const d = String(ddmmyyyy).padStart(8, '0');
    const t = String(hhmmss).padStart(6, '0');
    const day = d.substring(0, 2);
    const month = d.substring(2, 4);
    const year = d.substring(4, 8);
    const hours = t.substring(0, 2);
    const minutes = t.substring(2, 4);
    const seconds = t.substring(4, 6);

    // Explicitly parse as IST (+05:30)
    const isoString = `${year}-${month}-${day}T${hours}:${minutes}:${seconds}+05:30`;
    return new Date(isoString);
};

const scheduledJobs = new Map();
const absenteeJobs = new Map();

const markAbsenteesForTest = async (testId, batchId = null) => {
    try {
        const students = await Student.find(batchId ? { batchId } : {}, 'testId scores alarm');
        for (const student of students) {
            const alreadyMarked = (student.testId || []).includes(testId);
            if (alreadyMarked) continue;

            student.testId.push(testId);
            student.scores.push(-1); // -1 means absent
            student.alarm.push(0);
            if (student.activeAlarmByTest) {
                student.activeAlarmByTest.delete(testId);
            }
            await student.save();
        }
        console.log(`[Attendance] Marked absentees for test ${testId}`);
    } catch (err) {
        console.error(`[Attendance] Failed to mark absentees for test ${testId}:`, err);
    }
};

const scheduleExamStatus = (exam) => {
    if (scheduledJobs.has(exam._id.toString())) {
        const jobs = scheduledJobs.get(exam._id.toString());
        if (jobs.ongoingJob) jobs.ongoingJob.cancel();
        if (jobs.completedJob) jobs.completedJob.cancel();
        scheduledJobs.delete(exam._id.toString());
    }

    if (exam.status === 'cancelled') return;

    const startTime = parseExamDate(exam.examDate, exam.examTime);
    const endTime = new Date(startTime.getTime() + exam.duration * 60000);
    const now = new Date();

    const jobs = { ongoingJob: null, completedJob: null };

    const updateDB = async (status) => {
        try {
            await Exam.findByIdAndUpdate(exam._id, { status });
            console.log(`[Exam Sched] Exam ${exam.testId} status updated to ${status}`);
            if (status === 'completed' && !absenteeJobs.has(exam.testId)) {
                const absentJob = nodeSchedule.scheduleJob(new Date(Date.now() + 1800 * 1000), async () => {
                    await markAbsenteesForTest(exam.testId, exam.batchId);
                    absenteeJobs.delete(exam.testId);
                });
                absenteeJobs.set(exam.testId, absentJob);
                console.log(`[Attendance] Scheduled absentee mark job for test ${exam.testId} in 1800s`);
            }
        } catch (err) {
            console.error(`[Exam Sched] Error updating exam ${exam.testId} status:`, err);
        }
    };

    if (now < startTime) {
        if (exam.status !== 'scheduled') updateDB('scheduled');
        jobs.ongoingJob = nodeSchedule.scheduleJob(startTime, () => updateDB('ongoing'));
        jobs.completedJob = nodeSchedule.scheduleJob(endTime, () => updateDB('completed'));
    } else if (now >= startTime && now < endTime) {
        if (exam.status !== 'ongoing') updateDB('ongoing');
        jobs.completedJob = nodeSchedule.scheduleJob(endTime, () => updateDB('completed'));
    } else {
        if (exam.status !== 'completed') updateDB('completed');
    }


    if (jobs.ongoingJob || jobs.completedJob) {
        scheduledJobs.set(exam._id.toString(), jobs);
    }
};

const initExamSchedules = async () => {
    try {
        const exams = await Exam.find({ status: { $nin: ['completed', 'cancelled'] } });
        console.log(`[Exam Sched] Initializing schedules for ${exams.length} active exams`);
        exams.forEach(scheduleExamStatus);
    } catch (err) {
        console.error('[Exam Sched] Error initializing schedules:', err);
    }
};

app.get('/', (req, res) => {
    res.status(200).send('Zest Backend API is online.');
});

// --- Google OAuth Routes ---
app.get('/api/auth/google',
    (req, res, next) => {
        const { remember, returnTo } = req.query;
        if (req.session) {
            req.session.remember = remember === 'true';
            req.session.returnTo = returnTo || process.env.FRONTEND_URL;
        }
        passport.authenticate('google', { scope: ['profile', 'email'] })(req, res, next);
    }
);

app.get('/api/auth/google/callback',
    (req, res, next) => {
        console.log('[Auth] Callback reached. Query:', req.query);
        passport.authenticate('google', async (err, user, info) => {
            if (err) {
                console.error('[Auth] Passport Auth Error:', err);
                return res.status(500).json({ message: 'Authentication Error', error: err.message });
            }
            if (!user) {
                console.warn('[Auth] No user found in callback. Info:', info);
                return res.status(401).json({ message: 'User not found', info });
            }

            console.log('[Auth] Passport Authenticated User:', user.emailID);

            // Generate JWT token for the user
            try {
                const remember = req.session && req.session.remember;
                const token = jwt.sign(
                    { id: user._id.toString() }, 
                    process.env.JWT_SECRET || 'fallback_secret', 
                    { expiresIn: remember ? '30d' : '5h' }
                );
                const batch = user.batchId ? await Batch.findById(user.batchId) : null;
                const userStr = encodeURIComponent(JSON.stringify({
                    name: user.name,
                    email: user.emailID,
                    dp: user.profilePicture || '',
                    batchId: user.batchId || null,
                    batch: formatBatchForClient(batch)
                }));
                const frontendUrl = (req.session && req.session.returnTo) || process.env.FRONTEND_URL;
                const nextPath = user.batchId ? '/home' : '/select-batch';
                const redirectUrl = `${frontendUrl}${nextPath}?token=${token}&user=${userStr}&remember=${!!remember}`;

                console.log(`[Auth] Redirecting to: ${redirectUrl} (Remember: ${!!remember})`);
                res.redirect(redirectUrl);
            } catch (jwtErr) {
                console.error('[Auth] JWT Generation Error:', jwtErr);
                res.status(500).json({ message: 'Internal Server Error (JWT)' });
            }
        })(req, res, next);
    }
);

// --- Auth Endpoints ---

app.post('/api/auth/send-otp', async (req, res) => {
    try {
        let { email } = req.body;
        if (!email) return res.status(400).json({ message: 'Email required' });

        email = email.trim().toLowerCase();
        console.log(`[Auth] Attempting to send OTP to: ${email}`);

        if (!email.match(/^[a-zA-Z0-9._%+-]+@gmail\.com$/)) {
            console.log(`[Auth] Invalid email format: ${email}`);
            return res.status(400).json({ message: 'Invalid gmail address' });
        }

        // Generate 6-digit OTP
        const otp = Math.floor(100000 + Math.random() * 900000).toString();

        if (!process.env.BREVO_API_KEY) {
            console.error('[Auth] Missing BREVO_API_KEY');
            return res.status(500).json({ message: 'Email service is not configured.' });
        }

        if (!brevoSenderEmail) {
            console.error('[Auth] Missing BREVO_FROM_EMAIL/EMAIL_USER sender address');
            return res.status(500).json({ message: 'Email sender is not configured.' });
        }

        // Save OTP to DB (replaces existing if any for that email)
        await OTP.findOneAndUpdate(
            { email },
            { otp, createdAt: Date.now() },
            { upsert: true, returnDocument: 'after' }
        );
        console.log(`[Auth] OTP ${otp} saved/updated for ${email}`);

        // Send Email via Brevo (Legacy SDK)
        const sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail();
        sendSmtpEmail.subject = "🔒 Zest Verification Code: " + otp;
        sendSmtpEmail.htmlContent = `
                <!DOCTYPE html>
                <html>
                <head>
                    <style>
                        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;700;800&display=swap');
                        .email-container {
                            max-width: 600px;
                            margin: 20px auto;
                            font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                            background-color: #ffffff;
                            border-radius: 24px;
                            overflow: hidden;
                            box-shadow: 0 20px 50px rgba(0,0,0,0.05);
                            border: 1px solid #f1f5f9;
                        }
                        .header {
                            background: linear-gradient(135deg, #92c211 0%, #a8d630 100%);
                            padding: 40px 20px;
                            text-align: center;
                            position: relative;
                        }
                        .logo-text {
                            color: white;
                            font-size: 32px;
                            font-weight: 800;
                            letter-spacing: -1px;
                            margin: 0;
                            display: flex;
                            align-items: center;
                            justify-content: center;
                            gap: 10px;
                        }
                        .content {
                            padding: 40px;
                            color: #1e293b;
                            line-height: 1.6;
                        }
                        .otp-container {
                            background: #f8fafc;
                            border: 2px dashed #e2e8f0;
                            border-radius: 16px;
                            padding: 30px;
                            margin: 30px 0;
                            text-align: center;
                        }
                        .otp-code {
                            font-size: 48px;
                            font-weight: 800;
                            color: #92c211;
                            letter-spacing: 12px;
                            margin-right: -12px;
                        }
                        .footer {
                            padding: 30px;
                            background: #f1f5f9;
                            text-align: center;
                            font-size: 13px;
                            color: #64748b;
                        }
                    </style>
                </head>
                <body style="background-color: #f8fafc; padding: 20px;">
                    <div class="email-container">
                        <div class="header">
                            <h1 class="logo-text">
                                <div style="width: 40px; height: 40px; background: white; border-radius: 10px; display: inline-block; vertical-align: middle; margin-right: 10px;">
                                    <span style="color: #92c211; line-height: 40px; font-size: 24px;">Z</span>
                                </div>
                                Zest
                            </h1>
                        </div>
                        <div class="content">
                            <h2 style="font-size: 24px; margin-top: 0;">Verify your email</h2>
                            <p>Welcome to <strong>Zest</strong>! We're excited to help you track your DSA journey. To get started, please use the verification code below.</p>
                            
                            <div class="otp-container">
                                <div style="font-size: 12px; text-transform: uppercase; letter-spacing: 2px; color: #64748b; margin-bottom: 10px; font-weight: 700;">One-Time Password</div>
                                <div class="otp-code">${otp}</div>
                            </div>

                            <p style="font-size: 14px; color: #64748b;">This code will expire in <strong>5 minutes</strong>. If you didn't request this code, you can safely ignore this email.</p>
                        </div>
                        <div class="footer">
                            <p style="margin: 0;">&copy; ${new Date().getFullYear()} Zest Team for Algorithmist Academy</p>
                        </div>
                    </div>
                </body>
                </html>
            `;
        sendSmtpEmail.sender = { name: 'Zest', email: brevoSenderEmail };
        sendSmtpEmail.to = [{ email }];

        await apiInstance.sendTransacEmail(sendSmtpEmail);
        console.log(`[Auth] OTP email sent successfully via Brevo to ${email}`);
        res.json({ message: 'OTP sent to your email' });

    } catch (err) {
        const brevoError = err?.response?.body || err?.message || err;
        console.error('[Auth] Failed to send OTP email:', brevoError);
        res.status(500).json({
            message: 'Failed to send OTP. Check email settings.',
            error: typeof brevoError === 'string' ? brevoError : undefined
        });
    }
});

app.post('/api/auth/signup', async (req, res) => {
    try {
        let { name, email, password, otp } = req.body;
        if (!name || !email || !otp) return res.status(400).json({ message: 'Missing fields' });

        email = email.trim().toLowerCase();
        console.log(`[Auth] Signup attempt for: ${email}`);

        // Verify OTP
        const otpRecord = await OTP.findOne({ email, otp });
        if (!otpRecord) {
            console.log(`[Auth] Invalid or expired OTP for ${email}: ${otp}`);
            return res.status(400).json({ message: 'Invalid or expired OTP' });
        }
        console.log(`[Auth] OTP verified for ${email}`);

        // Immediate cleanup of verified OTP
        await OTP.deleteMany({ email });
        console.log(`[Auth] OTP records deleted for ${email} after verification`);

        // Basic verification
        if (!email.match(/^[a-zA-Z0-9._%+-]+@gmail\.com$/)) {
            return res.status(400).json({ message: 'Invalid gmail address' });
        }

        const existing = await Student.findOne({ emailID: email });
        if (existing) return res.status(400).json({ message: 'User already exists' });

        const normalizedPassword = typeof password === 'string' ? password.trim() : '';
        const hashedPassword = normalizedPassword
            ? await bcrypt.hash(normalizedPassword, 10)
            : null;

        if (normalizedPassword) {
            if (normalizedPassword.length < 8 || normalizedPassword.length > 25) {
                return res.status(400).json({ message: 'Password must be between 8 and 25 characters' });
            }
            if (!/[a-zA-Z]/.test(normalizedPassword) || !/[0-9]/.test(normalizedPassword)) {
                return res.status(400).json({ message: 'Password must contain both letters and numbers' });
            }
        }

        const newStudent = new Student({
            name,
            emailID: email,
            password: hashedPassword
        });

        await newStudent.save();
        res.status(201).json({
            message: 'Registration successful',
            user: await getStudentBatchResponse(newStudent)
        });

    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        let { email, password } = req.body || {};
        if (!email || !password) {
            return res.status(400).json({ message: 'Email and password are required' });
        }

        email = String(email).trim().toLowerCase();
        console.log(`[Auth] Login attempt for: ${email}`);

        const student = await Student.findOne({ emailID: email });
        if (!student) {
            console.log(`[Auth] Login failed: User not found for ${email}`);
            return res.status(401).json({ message: 'Invalid credentials' });
        }

        if (!student.password) {
            console.log(`[Auth] Login failed: No password set for ${email}`);
            return res.status(401).json({ message: 'This account uses Google sign-in. Please log in with Google.' });
        }

        const isMatch = await bcrypt.compare(password, student.password);
        if (!isMatch) {
            console.log(`[Auth] Login failed: Password mismatch for ${email}`);
            return res.status(401).json({ message: 'Invalid credentials' });
        }

        console.log(`[Auth] Login successful for: ${email}`);

        const token = jwt.sign({ id: student._id }, process.env.JWT_SECRET || 'fallback_secret', { expiresIn: '5h' });
        res.json({ token, user: await getStudentBatchResponse(student) });


    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// --- Verify OTP (without consuming it) ---
app.post('/api/auth/verify-otp', async (req, res) => {
    try {
        let { email, otp } = req.body;
        if (!email || !otp) return res.status(400).json({ message: 'Email and OTP required' });
        email = email.trim().toLowerCase();

        const otpRecord = await OTP.findOne({ email, otp });
        if (!otpRecord) {
            return res.status(400).json({ message: 'Invalid or expired OTP' });
        }

        // Check if OTP is older than 5 minutes
        const ageMs = Date.now() - new Date(otpRecord.createdAt).getTime();
        if (ageMs > 5 * 60 * 1000) {
            await OTP.deleteMany({ email });
            return res.status(400).json({ message: 'OTP has expired. Please request a new one.' });
        }

        res.json({ message: 'OTP verified' });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// --- Change Email (OTP verified) ---
app.put('/api/auth/change-email', async (req, res) => {
    try {
        let { currentEmail, newEmail, otp } = req.body;
        if (!currentEmail || !newEmail || !otp) return res.status(400).json({ message: 'Missing fields' });

        currentEmail = currentEmail.trim().toLowerCase();
        newEmail = newEmail.trim().toLowerCase();

        // Verify OTP
        const otpRecord = await OTP.findOne({ email: currentEmail, otp });
        if (!otpRecord) return res.status(400).json({ message: 'Invalid or expired OTP' });
        const ageMs = Date.now() - new Date(otpRecord.createdAt).getTime();
        if (ageMs > 5 * 60 * 1000) {
            await OTP.deleteMany({ email: currentEmail });
            return res.status(400).json({ message: 'OTP has expired. Please request a new one.' });
        }

        // Validate new email format
        if (!newEmail.match(/^[a-zA-Z0-9._%+-]+@gmail\.com$/)) {
            return res.status(400).json({ message: 'New email must be a valid Gmail address' });
        }

        // Check new email not already taken
        const existing = await Student.findOne({ emailID: newEmail });
        if (existing) return res.status(400).json({ message: 'This email is already registered' });

        // Update email
        const updated = await Student.findOneAndUpdate(
            { emailID: currentEmail },
            { emailID: newEmail },
            { returnDocument: 'after' }
        );
        if (!updated) return res.status(404).json({ message: 'User not found' });

        const batch = updated.batchId ? await Batch.findById(updated.batchId) : null;

        // Clean up OTP
        await OTP.deleteMany({ email: currentEmail });

        console.log(`[Auth] Email changed from ${currentEmail} to ${newEmail}`);
        res.json({
            message: 'Email updated successfully',
            user: {
                name: updated.name,
                email: updated.emailID,
                batchId: updated.batchId || null,
                batch: formatBatchForClient(batch)
            }
        });

    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// --- Change Password (OTP verified) ---
app.put('/api/auth/change-password', async (req, res) => {
    try {
        let { email, newPassword, otp } = req.body;
        if (!email || !newPassword || !otp) return res.status(400).json({ message: 'Missing fields' });

        email = email.trim().toLowerCase();

        // Verify OTP
        const otpRecord = await OTP.findOne({ email, otp });
        if (!otpRecord) return res.status(400).json({ message: 'Invalid or expired OTP' });
        const ageMs = Date.now() - new Date(otpRecord.createdAt).getTime();
        if (ageMs > 5 * 60 * 1000) {
            await OTP.deleteMany({ email });
            return res.status(400).json({ message: 'OTP has expired. Please request a new one.' });
        }

        if (newPassword.length < 8 || newPassword.length > 25) {
            return res.status(400).json({ message: 'Password must be between 8 and 25 characters' });
        }
        if (!/[a-zA-Z]/.test(newPassword) || !/[0-9]/.test(newPassword)) {
            return res.status(400).json({ message: 'Password must contain both letters and numbers' });
        }

        const hashedPassword = await bcrypt.hash(newPassword, 10);
        const updated = await Student.findOneAndUpdate(
            { emailID: email },
            { password: hashedPassword },
            { returnDocument: 'after' }
        );
        if (!updated) return res.status(404).json({ message: 'User not found' });

        // Clean up OTP
        await OTP.deleteMany({ email });

        const token = jwt.sign({ id: updated._id }, process.env.JWT_SECRET || 'fallback_secret', { expiresIn: '5h' });
        console.log(`[Auth] Password changed for ${email}`);
        res.json({ message: 'Password updated successfully', token, user: { name: updated.name, email: updated.emailID } });

    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// --- Login with OTP (Forgot Password -> Option 1) ---
app.post('/api/auth/login-with-otp', async (req, res) => {
    try {
        let { email, otp } = req.body;
        if (!email || !otp) return res.status(400).json({ message: 'Email and OTP required' });
        email = email.trim().toLowerCase();

        // Verify OTP
        const otpRecord = await OTP.findOne({ email, otp });
        if (!otpRecord) return res.status(400).json({ message: 'Invalid or expired OTP' });
        const ageMs = Date.now() - new Date(otpRecord.createdAt).getTime();
        if (ageMs > 5 * 60 * 1000) {
            await OTP.deleteMany({ email });
            return res.status(400).json({ message: 'OTP has expired. Please request a new one.' });
        }

        const student = await Student.findOne({ emailID: email });
        if (!student) {
            return res.status(404).json({ message: 'User not found' });
        }

        // Clean up OTP
        await OTP.deleteMany({ email });

        console.log(`[Auth] OTP Login successful for: ${email}`);

        const token = jwt.sign({ id: student._id }, process.env.JWT_SECRET || 'fallback_secret', { expiresIn: '5h' });
        res.json({ token, user: await getStudentBatchResponse(student) });

    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

app.post('/api/auth/select-batch', async (req, res) => {
    try {
        const { batchId } = req.body;
        const authHeader = req.headers.authorization;

        if (!authHeader) return res.status(401).json({ message: 'Authentication required' });
        if (!batchId) return res.status(400).json({ message: 'batchId is required' });

        const token = authHeader.split(' ')[1];
        let decoded;
        try {
            decoded = jwt.verify(token, process.env.JWT_SECRET || 'fallback_secret');
        } catch (e) {
            return res.status(401).json({ message: 'Invalid or expired token' });
        }

        const batch = await Batch.findById(batchId);
        if (!batch) return res.status(404).json({ message: 'Batch not found' });

        const student = await Student.findByIdAndUpdate(
            decoded.id,
            { batchId: batch._id },
            { returnDocument: 'after' }
        );

        if (!student) return res.status(404).json({ message: 'Student not found' });

        return res.json({
            message: 'Batch selected successfully',
            user: await getStudentBatchResponse(student)
        });
    } catch (err) {
        console.error('[Auth] Batch selection error:', err);
        return res.status(500).json({ message: 'Failed to select batch' });
    }
});

app.get('/api/batches', async (req, res) => {
    try {
        const batches = await Batch.find().sort({ createdAt: 1 });
        res.json(batches.map(formatBatchForClient));
    } catch (err) {
        console.error('[Batch] Error listing batches:', err);
        res.status(500).json({ message: 'Failed to fetch batches' });
    }
});

app.post('/api/batches', async (req, res) => {
    try {
        const { name } = req.body;
        if (!name || !name.trim()) {
            return res.status(400).json({ message: 'Batch name is required' });
        }

        const trimmedName = name.trim();
        const slug = normalizeBatchSlug(trimmedName);
        if (!slug) {
            return res.status(400).json({ message: 'Batch name is invalid' });
        }

        const existing = await Batch.findOne({ $or: [{ name: trimmedName }, { slug }] });
        if (existing) {
            return res.status(400).json({ message: 'Batch already exists' });
        }

        const batch = await Batch.create({ name: trimmedName, slug });
        return res.status(201).json({ batch: formatBatchForClient(batch) });
    } catch (err) {
        console.error('[Batch] Error creating batch:', err);
        return res.status(500).json({ message: 'Failed to create batch' });
    }
});

app.put('/api/batches/:id', async (req, res) => {
    try {
        const { name } = req.body;
        if (!name || !name.trim()) {
            return res.status(400).json({ message: 'Batch name is required' });
        }

        const batch = await Batch.findById(req.params.id);
        if (!batch) return res.status(404).json({ message: 'Batch not found' });

        const trimmedName = name.trim();
        const slug = normalizeBatchSlug(trimmedName);
        const duplicate = await Batch.findOne({ _id: { $ne: batch._id }, $or: [{ name: trimmedName }, { slug }] });
        if (duplicate) {
            return res.status(400).json({ message: 'Another batch already uses this name' });
        }

        batch.name = trimmedName;
        batch.slug = slug;
        await batch.save();

        return res.json({ batch: formatBatchForClient(batch) });
    } catch (err) {
        console.error('[Batch] Error updating batch:', err);
        return res.status(500).json({ message: 'Failed to update batch' });
    }
});

app.delete('/api/batches/:id', async (req, res) => {
    try {
        const batch = await Batch.findById(req.params.id);
        if (!batch) return res.status(404).json({ message: 'Batch not found' });

        await Promise.all([
            Student.updateMany({ batchId: batch._id }, { $set: { batchId: null } }),
            Exam.updateMany({ batchId: batch._id }, { $set: { batchId: null } }),
            TestContent.updateMany({ batchId: batch._id }, { $set: { batchId: null } }),
            Notification.updateMany({ batchId: batch._id }, { $set: { batchId: null } }),
            OTP.updateMany({ batchId: batch._id }, { $set: { batchId: null } })
        ]);

        await Batch.deleteOne({ _id: batch._id });
        return res.json({ message: 'Batch deleted successfully' });
    } catch (err) {
        console.error('[Batch] Error deleting batch:', err);
        return res.status(500).json({ message: 'Failed to delete batch' });
    }
});


app.post('/api/exams', async (req, res) => {
    try {
        const examData = req.body;
        if (!examData.examName || !examData.examDate || !examData.examTime || !examData.testId) {
            return res.status(400).json({ message: 'Missing required fields' });
        }
        if (!examData.batchId) {
            return res.status(400).json({ message: 'batchId is required when scheduling an exam' });
        }
        const existingExam = await Exam.findOne({ testId: examData.testId });
        const upsertedExam = await Exam.findOneAndUpdate(
            { testId: examData.testId },
            {
                ...examData,
                status: existingExam?.status || examData.status || 'scheduled'
            },
            {
                upsert: true,
                runValidators: true,
                returnDocument: 'after',
                setDefaultsOnInsert: true
            }
        );
        scheduleExamStatus(upsertedExam);
        res.status(existingExam ? 200 : 201).json({
            message: existingExam ? 'Exam updated successfully!' : 'Exam scheduled successfully!',
            exam: upsertedExam
        });
    } catch (err) {
        console.error('Error scheduling exam:', err);
        res.status(500).json({ message: 'Failed to schedule exam', error: err.message });
    }
});

// GET all exams
app.get('/api/exams', async (req, res) => {
    try {
        const { batchId } = req.query;
        const exams = await Exam.find(batchId ? { batchId } : {}).sort({ createdAt: -1 });
        res.json(exams);
    } catch (err) {
        res.status(500).json({ message: 'Failed to fetch exams' });
    }
});

// UPDATE an exam
app.put('/api/exams/:id', async (req, res) => {
    try {
        const oldExam = await Exam.findById(req.params.id);
        if (!oldExam) return res.status(404).json({ message: 'Exam not found' });
        
        const oldTestId = oldExam.testId;
        const newTestId = req.body.testId;

        if (req.body.batchId && String(req.body.batchId) !== String(oldExam.batchId || '')) {
            return res.status(400).json({ message: 'Exam batch cannot be changed after creation' });
        }

        const updatedExam = await Exam.findByIdAndUpdate(req.params.id, req.body, { returnDocument: 'after' });
        
        // Cascade testId update to TestContent (buildcontent) if it changed
        if (newTestId && newTestId !== oldTestId) {
            console.log(`[Sync] testId changed from ${oldTestId} to ${newTestId}. Updating TestContent records...`);
            await TestContent.updateMany({ testId: oldTestId }, { testId: newTestId });
        }

        scheduleExamStatus(updatedExam);
        res.json({ message: 'Exam updated successfully!', exam: updatedExam });
    } catch (err) {
        console.error('Error updating exam:', err);
        res.status(500).json({ message: 'Failed to update exam' });
    }
});

// DELETE an exam
app.delete('/api/exams/:id', async (req, res) => {
    try {
        const deletedExam = await Exam.findByIdAndDelete(req.params.id);
        if (!deletedExam) return res.status(404).json({ message: 'Exam not found' });
        if (scheduledJobs.has(deletedExam._id.toString())) {
            const jobs = scheduledJobs.get(deletedExam._id.toString());
            if (jobs.ongoingJob) jobs.ongoingJob.cancel();
            if (jobs.completedJob) jobs.completedJob.cancel();
            scheduledJobs.delete(deletedExam._id.toString());
        }
        res.json({ message: 'Exam deleted successfully!' });
    } catch (err) {
        res.status(500).json({ message: 'Failed to delete exam' });
    }
});


// GET exam by explicit testId string
app.get('/api/exams/by-testid/:testId', async (req, res) => {
    try {
        const { batchId } = req.query;
        const exam = await Exam.findOne({ testId: req.params.testId, ...(batchId ? { batchId } : {}) });
        if (!exam) return res.status(404).json({ message: 'Exam not found' });
        res.json(exam);
    } catch (err) {
        res.status(500).json({ message: 'Failed to fetch exam by testId' });
    }
});

// GET database and collection storage stats
app.get('/api/admin/storage-stats', async (req, res) => {
    try {
        const db = mongoose.connection.db;
        const collections = await db.listCollections().toArray();
        const stats = [];
        let totalStorageUsed = 0;

        for (const coll of collections) {
            const collStats = await db.command({ collStats: coll.name });
            const size = collStats.storageSize || 0;
            stats.push({
                name: coll.name,
                sizeBytes: size,
                documents: collStats.count
            });
            totalStorageUsed += size;
        }

        // Calculate percentages
        const result = stats.map(s => ({
            ...s,
            percentage: totalStorageUsed > 0 ? ((s.sizeBytes / totalStorageUsed) * 100).toFixed(2) : 0
        }));

        const maxStorageBytes = 512 * 1024 * 1024; // 512MB for Atlas M0 Free Tier
        const totalPercentageUsed = ((totalStorageUsed / maxStorageBytes) * 100).toFixed(2);

        res.json({
            totalStorageUsed,
            maxStorageBytes,
            totalPercentageUsed,
            collections: result.sort((a, b) => b.sizeBytes - a.sizeBytes)
        });
    } catch (err) {
        console.error('Error fetching storage stats:', err);
        res.status(500).json({ message: 'Failed to fetch storage statistics' });
    }
});

// GET test content by testId — merges live exam metadata from Exam collection
app.get('/api/test-contents/:testId', async (req, res) => {
    try {
        const { batchId } = req.query;
        const testContent = await TestContent.findOne({ testId: req.params.testId, ...(batchId ? { batchId } : {}) });
        if (!testContent) return res.status(404).json({ message: 'Test content not found' });

        // Fetch exam metadata from the single source of truth
        const exam = await Exam.findOne({ testId: req.params.testId, ...(req.query.batchId ? { batchId: req.query.batchId } : {}) });

        res.json({
            _id: testContent._id,
            testId: testContent.testId,
            questions: normalizeQuestions(testContent.questions),
            createdAt: testContent.createdAt,
            updatedAt: testContent.updatedAt,
            // Live metadata from exams collection
            examName: exam ? exam.examName : null,
            totalMarks: exam ? exam.totalMarks : null,
            passingMarks: exam ? exam.passingMarks : null,
            duration: exam ? exam.duration : null,
        });
    } catch (err) {
        res.status(500).json({ message: 'Failed to fetch test content' });
    }
});

// POST to save/update test content (stores only testId + questions)
app.post('/api/test-contents', async (req, res) => {
    try {
        const { testId, questions } = req.body;
        if (!testId || !questions) {
            return res.status(400).json({ message: 'Missing required fields: testId and questions' });
        }

        // Verify the testId exists in exams collection
        const exam = await Exam.findOne({ testId, ...(req.body.batchId ? { batchId: req.body.batchId } : {}) });
        if (!exam) {
            return res.status(404).json({ message: 'No scheduled exam found for this testId' });
        }

        const normalizedQuestions = normalizeQuestions(questions);

        // Upsert logic — only store testId and questions
        let testContent = await TestContent.findOne({ testId, ...(exam.batchId ? { batchId: exam.batchId } : {}) });
        if (testContent) {
            testContent = await TestContent.findOneAndUpdate(
                { testId, ...(exam.batchId ? { batchId: exam.batchId } : {}) },
                { questions: normalizedQuestions, batchId: exam.batchId || null },
                { returnDocument: 'after' }
            );
            return res.status(200).json({ message: 'Test content updated successfully!', testContent });
        } else {
            testContent = new TestContent({ testId, batchId: exam.batchId || null, questions: normalizedQuestions });
            await testContent.save();
            return res.status(201).json({ message: 'Test content created successfully!', testContent });
        }
    } catch (err) {
        console.error('Error saving test content:', err);
        res.status(500).json({ message: 'Failed to save test content', error: err.message });
    }
});

// POST /api/test/wrong-answer — record a wrong attempt during an in-progress test
app.post('/api/test/wrong-answer', async (req, res) => {
    try {
        const { testId, questionId, questionNo, studentAnswer } = req.body;
        if (!testId || !questionId) {
            return res.status(400).json({ message: 'Missing required wrong-answer fields' });
        }

        const authHeader = req.headers.authorization;
        if (!authHeader) return res.status(401).json({ message: 'Authentication required' });
        const token = authHeader.split(' ')[1];

        let decoded;
        try {
            decoded = jwt.verify(token, process.env.JWT_SECRET || 'fallback_secret');
        } catch (e) {
            return res.status(401).json({ message: 'Invalid or expired token' });
        }

        const student = await Student.findById(decoded.id);
        if (!student) return res.status(404).json({ message: 'Student not found' });

        student.wrongAnswers = Array.isArray(student.wrongAnswers) ? student.wrongAnswers : [];
        const wrongAttempt = {
            testId,
            questionId,
            questionNo: Number(questionNo) || null,
            answer: formatStudentAnswerForStorage(studentAnswer),
            recordedAt: new Date()
        };
        const attemptIndex = student.wrongAnswers.findIndex(
            (attempt) => String(attempt.testId) === String(testId) && String(attempt.questionId) === String(questionId)
        );
        if (attemptIndex >= 0) {
            student.wrongAnswers[attemptIndex] = {
                ...student.wrongAnswers[attemptIndex].toObject?.(),
                ...wrongAttempt
            };
        } else {
            student.wrongAnswers.push(wrongAttempt);
        }
        const saved = await student.save();

        return res.json({ message: 'Wrong attempt recorded', saved: Boolean(saved) });
    } catch (err) {
        console.error('[Test] Error recording wrong answer:', err);
        return res.status(500).json({ message: 'Failed to record wrong answer' });
    }
});

// POST /api/test/run-java-testcases — Run Java code against test cases (used during test-taking)
app.post('/api/test/run-java-testcases', async (req, res) => {
    try {
        const { code, testCases } = req.body;
        if (!code || !testCases) return res.status(400).json({ message: 'Code and test cases required' });
        const result = await runJavaTestCases(code, testCases);
        res.json(result);
    } catch (err) {
        console.error('Error running Java test cases:', err);
        res.status(500).json({ message: 'Failed to execute code' });
    }
});

// POST /api/test/submit — Submit entire test, evaluate all answers, save score to student
app.post('/api/test/submit', async (req, res) => {
    try {
        const { testId, answers, alarmCount, yellowWarningCount } = req.body;

        // Authenticate student via JWT
        const authHeader = req.headers.authorization;
        if (!authHeader) {
            console.warn('[Test] Submit blocked: missing Authorization header');
            return res.status(401).json({ message: 'Authentication required' });
        }

        const [scheme, token] = authHeader.split(' ');
        if (scheme !== 'Bearer' || !token) {
            console.warn('[Test] Submit blocked: malformed Authorization header', authHeader);
            return res.status(401).json({ message: 'Malformed authorization header' });
        }

        let decoded;
        try {
            decoded = jwt.verify(token, process.env.JWT_SECRET || 'fallback_secret');
        } catch (e) {
            console.warn('[Test] Submit blocked: invalid JWT', { name: e.name, message: e.message });
            return res.status(401).json({ message: 'Invalid or expired token' });
        }

        const student = await Student.findById(decoded.id);
        if (!student) return res.status(404).json({ message: 'Student not found' });

        // Prevent duplicate submission
        if ((student.testId || []).some((submittedTestId) => String(submittedTestId) === String(testId))) {
            return res.status(400).json({ message: 'You have already submitted this test' });
        }

        // Fetch test content and exam metadata
        const testContent = await TestContent.findOne({ testId, ...(student.batchId ? { batchId: student.batchId } : {}) });
        if (!testContent) return res.status(404).json({ message: 'Test content not found' });
        const exam = await Exam.findOne({ testId, ...(student.batchId ? { batchId: student.batchId } : {}) });

        let totalScore = 0;
        const questionResults = [];

        for (let i = 0; i < testContent.questions.length; i++) {
            const question = testContent.questions[i];
            const studentAnswer = answers ? answers[String(i)] : undefined;
            let isCorrect = false;
            let earnedMarks = 0;

            // Check if unattempted
            const isUnattempted = studentAnswer === undefined || studentAnswer === null || studentAnswer === '' ||
                (Array.isArray(studentAnswer) && studentAnswer.length === 0);

            if (isUnattempted) {
                questionResults.push({ qIndex: i, correct: false, marks: 0, maxMarks: question.marks || 0, status: 'unattempted' });
                continue;
            }

            switch (question.type) {
                case 'single option answer':
                    isCorrect = String(studentAnswer).trim() === String(question.answerKey).trim();
                    break;
                case 'multiple option answer': {
                    const correctArr = Array.isArray(question.answerKey) ? [...question.answerKey].sort() : [];
                    const studentArr = Array.isArray(studentAnswer) ? [...studentAnswer].sort() : [];
                    isCorrect = JSON.stringify(correctArr) === JSON.stringify(studentArr);
                    break;
                }
                case 'value enter answer':
                    isCorrect = String(studentAnswer).trim().toLowerCase() === String(question.answerKey).trim().toLowerCase();
                    break;
                case 'write code answer': {
                    if (question.testCases && question.testCases.length > 0) {
                        const codeResult = await runJavaTestCases(studentAnswer, question.testCases);
                        isCorrect = codeResult.allPassed;
                    }
                    break;
                }
            }

            if (isCorrect) {
                earnedMarks = question.marks || 0;
                totalScore += earnedMarks;
            } else {
                await upsertWrongAnswerRecord({
                    student,
                    testId,
                    question,
                    studentAnswer,
                    codeResult: question.type === 'write code answer' && studentAnswer
                        ? await runJavaTestCases(studentAnswer, question.testCases)
                        : null
                });
            }

            questionResults.push({
                qIndex: i,
                correct: isCorrect,
                marks: earnedMarks,
                maxMarks: question.marks || 0,
                status: 'attempted'
            });
        }

        // Save score to student record
        student.scores.push(totalScore);
        student.testId.push(testId);
        const resolvedAlarmCount = Number.isFinite(Number(alarmCount))
            ? Number(alarmCount)
            : Number(student.activeAlarmByTest?.get(testId) || 0);
        student.alarm.push(resolvedAlarmCount);
        if (student.activeAlarmByTest) {
            student.activeAlarmByTest.delete(testId);
        }

        await storeYellowWarningCount({
            student,
            testId,
            yellowWarningCount: Number.isFinite(Number(yellowWarningCount))
                ? Number(yellowWarningCount)
                : Number(student.activeYellowWarningByTest?.get(testId) || 0)
        });

        await student.save();

        console.log(`[Test] Student ${student.emailID} submitted test ${testId} — Score: ${totalScore}`);

        const maxMarks = exam ? exam.totalMarks : testContent.questions.reduce((sum, q) => sum + (q.marks || 0), 0);
        res.json({
            totalScore,
            totalMarks: maxMarks,
            passingMarks: exam ? exam.passingMarks : 0,
            examName: exam ? exam.examName : 'Test',
            questionResults,
            totalQuestions: testContent.questions.length
        });

    } catch (err) {
        console.error('[Test] Error submitting test:', err);
        res.status(500).json({ message: 'Failed to submit test', error: err.message });
    }
});


// GET /api/student/submitted-tests — Returns list of testIds student has already submitted
app.get('/api/student/submitted-tests', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader) return res.status(401).json({ message: 'Auth required' });
        const [scheme, token] = authHeader.split(' ');
        if (scheme !== 'Bearer' || !token) {
            return res.status(401).json({ message: 'Malformed authorization header' });
        }
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'fallback_secret');
        const student = await Student.findById(decoded.id, 'testId batchId');
        if (!student) return res.status(404).json({ message: 'Student not found' });
        res.json({ submittedTestIds: student.testId || [] });
    } catch (err) {
        res.status(500).json({ message: 'Failed to fetch submitted tests' });
    }
});

// POST /api/test/alarm — persist latest alarm count for an in-progress test
app.post('/api/test/alarm', async (req, res) => {
    try {
        const { testId, alarmCount } = req.body;
        if (!testId || !Number.isFinite(Number(alarmCount))) {
            return res.status(400).json({ message: 'testId and numeric alarmCount are required' });
        }

        const authHeader = req.headers.authorization;
        if (!authHeader) return res.status(401).json({ message: 'Authentication required' });
        const [scheme, token] = authHeader.split(' ');
        if (scheme !== 'Bearer' || !token) {
            return res.status(401).json({ message: 'Malformed authorization header' });
        }

        let decoded;
        try {
            decoded = jwt.verify(token, process.env.JWT_SECRET || 'fallback_secret');
        } catch (e) {
            return res.status(401).json({ message: 'Invalid or expired token' });
        }

        const student = await Student.findById(decoded.id);
        if (!student) return res.status(404).json({ message: 'Student not found' });

        student.activeAlarmByTest.set(testId, Number(alarmCount));
        await student.save();

        return res.json({ message: 'Alarm count stored', alarmCount: Number(alarmCount) });
    } catch (err) {
        console.error('[Test] Error storing alarm count:', err);
        return res.status(500).json({ message: 'Failed to store alarm count' });
    }
});

// GET /api/test/late-entry-status/:testId — check if late entry is allowed for student
app.get('/api/test/late-entry-status/:testId', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader) return res.status(401).json({ message: 'Authentication required' });
        const token = authHeader.split(' ')[1];

        let decoded;
        try {
            decoded = jwt.verify(token, process.env.JWT_SECRET || 'fallback_secret');
        } catch (e) {
            return res.status(401).json({ message: 'Invalid or expired token' });
        }

        const student = await Student.findById(decoded.id);
        if (!student) return res.status(404).json({ message: 'Student not found' });

        const request = await Notification.findOne({
            type: 'late_entry',
            studentId: student._id,
            testId: req.params.testId,
            ...(student.batchId ? { batchId: student.batchId } : {})
        }).sort({ createdAt: -1 });

        return res.json({ status: request ? request.status : 'none' });
    } catch (err) {
        console.error('[LateEntry] Error checking status:', err);
        return res.status(500).json({ message: 'Failed to check late entry status' });
    }
});

// POST /api/test/late-entry-request — create/update late entry request notification for admin
app.post('/api/test/late-entry-request', async (req, res) => {
    try {
        const { testId } = req.body;
        if (!testId) return res.status(400).json({ message: 'testId is required' });

        const authHeader = req.headers.authorization;
        if (!authHeader) return res.status(401).json({ message: 'Authentication required' });
        const token = authHeader.split(' ')[1];

        let decoded;
        try {
            decoded = jwt.verify(token, process.env.JWT_SECRET || 'fallback_secret');
        } catch (e) {
            return res.status(401).json({ message: 'Invalid or expired token' });
        }

        const student = await Student.findById(decoded.id);
        if (!student) return res.status(404).json({ message: 'Student not found' });

        const existingPending = await Notification.findOne({
            type: 'late_entry',
            studentId: student._id,
            testId,
            status: 'pending',
            ...(student.batchId ? { batchId: student.batchId } : {})
        });

        if (existingPending) {
            return res.status(200).json({ message: 'Late entry request already pending', notification: existingPending });
        }

        const notification = await Notification.create({
            type: 'late_entry',
            studentId: student._id,
            studentName: student.name,
            studentEmail: student.emailID,
            testId,
            batchId: student.batchId || null,
            status: 'pending'
        });

        return res.status(201).json({ message: 'Late entry request sent to admin', notification });
    } catch (err) {
        console.error('[LateEntry] Error creating late entry request:', err);
        return res.status(500).json({ message: 'Failed to create late entry request' });
    }
});

// GET /api/admin/notifications — list late-entry notifications for admin
app.get('/api/admin/notifications', async (req, res) => {
    try {
        const { batchId } = req.query;
        const notifications = await Notification.find({ type: 'late_entry', ...(batchId ? { batchId } : {}) }).sort({ createdAt: -1 });
        return res.json(notifications);
    } catch (err) {
        console.error('[Admin] Error fetching notifications:', err);
        return res.status(500).json({ message: 'Failed to fetch notifications' });
    }
});

// POST /api/admin/notifications/:id/decision — allow or deny late entry request
app.post('/api/admin/notifications/:id/decision', async (req, res) => {
    try {
        const { decision } = req.body;
        if (!['allow', 'deny'].includes(decision)) {
            return res.status(400).json({ message: "decision must be 'allow' or 'deny'" });
        }

        const mappedStatus = decision === 'allow' ? 'allowed' : 'denied';
        const updated = await Notification.findByIdAndUpdate(
            req.params.id,
            { status: mappedStatus },
            { returnDocument: 'after' }
        );

        if (!updated) return res.status(404).json({ message: 'Notification not found' });
        return res.json({ message: `Late entry ${mappedStatus}`, notification: updated });
    } catch (err) {
        console.error('[Admin] Error deciding notification:', err);
        return res.status(500).json({ message: 'Failed to update notification' });
    }
});

// DELETE /api/admin/notifications — delete late-entry notifications in bulk
app.delete('/api/admin/notifications', async (req, res) => {
    try {
        const { batchId } = req.query;
        const filter = { type: 'late_entry', ...(batchId ? { batchId } : {}) };
        const result = await Notification.deleteMany(filter);
        return res.json({
            message: 'Notifications deleted successfully',
            deletedCount: result.deletedCount || 0
        });
    } catch (err) {
        console.error('[Admin] Error deleting notifications:', err);
        return res.status(500).json({ message: 'Failed to delete notifications' });
    }
});

// GET /api/admin/reports/alarms — tabular alarm report by student and test
app.get('/api/admin/reports/alarms', async (req, res) => {
    try {
        const { batchId, testId } = req.query;
        const students = await Student.find(batchId ? { batchId } : {}, 'name emailID testId scores alarm yellowWarning batchId');
        const rows = [];
        students.forEach((student) => {
            const maxLen = Math.max(student.testId?.length || 0, student.scores?.length || 0, student.alarm?.length || 0, student.yellowWarning?.length || 0);
            for (let i = 0; i < maxLen; i++) {
                const currentTestId = student.testId?.[i] || '-';
                if (testId && String(currentTestId) !== String(testId)) {
                    continue;
                }
                rows.push({
                    studentName: student.name,
                    studentEmail: student.emailID,
                    testId: currentTestId,
                    score: Number.isFinite(student.scores?.[i]) ? student.scores[i] : '-',
                    alarmCount: Number.isFinite(student.alarm?.[i]) ? student.alarm[i] : 0,
                    yellowWarningCount: Number.isFinite(student.yellowWarning?.[i]) ? student.yellowWarning[i] : 0
                });
            }
        });
        return res.json(rows);
    } catch (err) {
        console.error('[Admin] Error building alarm report:', err);
        return res.status(500).json({ message: 'Failed to fetch alarm report' });
    }
});

// GET /api/admin/reports/wrong-answers — flattened wrong-attempt report
app.get('/api/admin/reports/wrong-answers', async (req, res) => {
    try {
        const { batchId, testId, student } = req.query;
        const filter = {
            ...(batchId ? { batchId } : {})
        };
        const docs = await Student.find(filter, 'name emailID batchId wrongAnswers').sort({ updatedAt: -1 }).lean();
        const rows = [];
        const studentQuery = String(student || '').trim().toLowerCase();

        docs.forEach((doc) => {
            if (studentQuery) {
                if (!String(doc.name || '').toLowerCase().includes(studentQuery) && !String(doc.emailID || '').toLowerCase().includes(studentQuery)) {
                    return;
                }
            }

            (doc.wrongAnswers || []).forEach((attempt) => {
                if (testId && String(attempt.testId) !== String(testId)) {
                    return;
                }
                rows.push({
                    studentName: doc.name,
                    studentEmail: doc.emailID,
                    testId: attempt.testId,
                    questionId: attempt.questionId,
                    questionNo: attempt.questionNo,
                    studentAnswer: attempt.answer,
                    batchId: doc.batchId || null
                });
            });
        });

        return res.json(rows);
    } catch (err) {
        console.error('[Admin] Error building wrong-answer report:', err);
        return res.status(500).json({ message: 'Failed to fetch wrong-answer report' });
    }
});

// GET /api/student/analytics — student performance and trend data
app.get('/api/student/analytics', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader) return res.status(401).json({ message: 'Auth required' });
        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'fallback_secret');
        const student = await Student.findById(decoded.id, 'name scores testId batchId');
        if (!student) return res.status(404).json({ message: 'Student not found' });

        const exams = await Exam.find(student.batchId ? { batchId: student.batchId } : {}, 'testId examName totalMarks batchId').lean();
        const examMap = new Map(exams.map(e => [String(e.testId), e]));

        const attempts = (student.testId || []).map((tid, idx) => {
            const exam = examMap.get(String(tid));
            const score = Number.isFinite(student.scores?.[idx]) ? student.scores[idx] : 0;
            const totalMarks = Number.isFinite(exam?.totalMarks) ? exam.totalMarks : 100;
            const percentage = totalMarks > 0 && score >= 0 ? (score / totalMarks) * 100 : -1;
            return {
                index: idx + 1,
                testId: tid,
                examName: exam?.examName || `Test ${tid}`,
                score,
                totalMarks,
                percentage
            };
        });

        const validAttempts = attempts.filter(a => a.score >= 0);
        const avgPct = validAttempts.length
            ? validAttempts.reduce((sum, a) => sum + a.percentage, 0) / validAttempts.length
            : 0;

        const highScoringTests = validAttempts
            .filter(a => a.percentage >= Math.max(60, avgPct))
            .map(a => ({ testId: a.testId, examName: a.examName, score: a.score, percentage: a.percentage }));
        const lowScoringTests = attempts
            .filter(a => a.score === -1 || a.percentage < 40)
            .map(a => ({ testId: a.testId, examName: a.examName, score: a.score, percentage: a.percentage }));

        return res.json({
            studentName: student.name,
            attempts,
            averagePercentage: Number(avgPct.toFixed(2)),
            highScoringTests,
            lowScoringTests
        });
    } catch (err) {
        console.error('[Analytics] Error fetching student analytics:', err);
        return res.status(500).json({ message: 'Failed to fetch analytics' });
    }
});

// GET /api/admin/attendance — attendance summary and per-student rows by test
app.get('/api/admin/attendance', async (req, res) => {
    try {
        const { batchId } = req.query;
        const exams = await Exam.find(batchId ? { batchId } : {}, 'testId examName examDate batchId').sort({ examDate: -1 }).lean();
        const students = await Student.find(batchId ? { batchId } : {}, 'name emailID testId scores batchId').lean();

        const tests = exams.map((exam) => {
            let present = 0;
            let absent = 0;
            const rows = [];

            students.forEach((student) => {
                const idx = (student.testId || []).findIndex((tid) => String(tid) === String(exam.testId));
                if (idx === -1) return;
                const score = Number.isFinite(student.scores?.[idx]) ? student.scores[idx] : 0;
                const status = score === -1 ? 'absent' : 'present';
                if (status === 'present') present += 1;
                else absent += 1;
                rows.push({
                    studentName: student.name,
                    studentEmail: student.emailID,
                    score: status === 'absent' ? 0 : score,
                    status
                });
            });

            return {
                testId: exam.testId,
                examName: exam.examName,
                examDate: exam.examDate,
                present,
                absent,
                rows
            };
        });

        return res.json(tests);
    } catch (err) {
        console.error('[Attendance] Error fetching attendance:', err);
        return res.status(500).json({ message: 'Failed to fetch attendance' });
    }
});

// GET active students (Admin only)
app.get('/api/admin/active-students', (req, res) => {
    try {
        const { batchId } = req.query;
        const usersList = Array.from(activeUsers.values()).map(user => ({
            name: user.name,
            email: user.email,
            dp: user.dp || user.profilePicture,
            lastActive: user.lastActive,
            location: user.location || '/home',
            locationStartedAt: user.locationStartedAt || user.lastActive,
            batchId: user.batchId || null,
            batch: user.batch || null
        })).filter(user => !batchId || String(user.batchId || '') === String(batchId));
        res.json(usersList);
    } catch (error) {
        console.error('Error fetching active students:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});


// GET leaderboard (ranked students)
app.get('/api/leaderboard', async (req, res) => {
    try {
        const { batchId } = req.query;
        const students = await Student.find(batchId ? { batchId } : {}, 'name scores profilePicture batchId');
        const leaderboard = students.map(s => {
            const totalScore = s.scores.reduce((sum, score) => sum + Math.max(Number(score) || 0, 0), 0);
            return {
                name: s.name,
                totalScore: totalScore,
                testsTaken: s.scores.length,
                profilePicture: s.profilePicture
            };
        });

        // Sort by total score descending
        leaderboard.sort((a, b) => b.totalScore - a.totalScore);

        // Return top 20
        res.json(leaderboard.slice(0, 20));
    } catch (err) {
        console.error('Leaderboard fetch error:', err);
        res.status(500).json({ message: 'Failed to fetch leaderboard' });
    }
});

// Original REST endpoint for simple compilation
app.post('/compile', (req, res) => {
    let { code, input } = req.body;
    if (!code) return res.status(400).send('No code provided');

    const className = getClassName(code);
    const sessionId = uuidv4();
    const sessionDir = path.join(TEMP_DIR, sessionId);
    fs.mkdirSync(sessionDir);

    const javaFile = path.join(sessionDir, `${className}.java`);
    fs.writeFileSync(javaFile, code);

    exec(`javac "${className}.java"`, { cwd: sessionDir }, (error, stdout, stderr) => {
        if (error || stderr) {
            fs.rmSync(sessionDir, { recursive: true, force: true });
            return res.send(stderr || error.message);
        }

        const child = spawn('java', [className], { cwd: sessionDir });
        let output = '';

        child.stdout.on('data', (data) => { output += data.toString(); });
        child.stderr.on('data', (data) => { output += data.toString(); });

        if (input) child.stdin.write(input);
        child.stdin.end();

        const timer = setTimeout(() => {
            child.kill();
            res.send(output + '\n[Execution Timed Out]');
        }, 5000);

        child.on('close', () => {
            clearTimeout(timer);
            fs.rmSync(sessionDir, { recursive: true, force: true });
            res.send(output || 'Program executed with no output.');
        });
    });
});


// WebSocket for real-time interactive terminal
io.on('connection', (socket) => {
    let child = null;
    let sessionDir = null;
    let currentUserEmail = null;

    socket.on('user-online', (userData) => {
        if (userData && userData.email) {
            currentUserEmail = userData.email;
            const isPersistent = !!userData.isPersistent;
            activeUsers.set(userData.email, {
                ...userData,
                isPersistent: isPersistent,
                lastActive: new Date(),
                location: userData.location || '/home',
                locationStartedAt: new Date(),
                socketId: socket.id
            });
            console.log(`[Presence] Student ${userData.name} is now online (Persistent: ${isPersistent}) at ${userData.location || '/home'}.`);

            // Broadcast update to all connected clients (including admins)
            // The admin portal polls every 30s, but this allows for future real-time push
            io.emit('admin-update-active', Array.from(activeUsers.values()));

        }
    });

    socket.on('page-view', ({ location }) => {
        if (currentUserEmail && activeUsers.has(currentUserEmail)) {
            const user = activeUsers.get(currentUserEmail);
            const wasTesting = user.location && user.location.startsWith('/test/');
            const isTesting = location && location.startsWith('/test/');

            // Only update the "Joined Since" timer if we are switching between 
            // the Dashboard (any non-test page) and the Test environment.
            if (wasTesting !== isTesting) {
                user.locationStartedAt = new Date();
            }
            user.location = location;
            user.lastActive = new Date();
            activeUsers.set(currentUserEmail, user);
            console.log(`[Presence] Student ${currentUserEmail} moved to ${location}.`);
            io.emit('admin-update-active', Array.from(activeUsers.values()));
        }
    });

    socket.on('run-code', ({ code }) => {
        if (!code) return socket.emit('output', 'No code provided');

        const className = getClassName(code);
        const sessionId = uuidv4();
        sessionDir = path.join(TEMP_DIR, sessionId);
        fs.mkdirSync(sessionDir);

        const javaFile = path.join(sessionDir, `${className}.java`);
        fs.writeFileSync(javaFile, code);

        socket.emit('output', `Compiling ${className}.java...\n`);

        exec(`javac "${className}.java"`, { cwd: sessionDir }, (error, stdout, stderr) => {
            if (error || stderr) {
                socket.emit('output', stderr || error.message);
                socket.emit('exit', 1); // Fix: Send exit even on error
                if (sessionDir && fs.existsSync(sessionDir)) {
                    fs.rmSync(sessionDir, { recursive: true, force: true });
                }
                return;
            }

            socket.emit('output', 'Running...\n');
            child = spawn('java', [className], { cwd: sessionDir });

            // Add timeout for interactive execution
            const timer = setTimeout(() => {
                if (child) {
                    child.kill();
                    socket.emit('output', '\n[Execution Timed Out (300s)]\n');
                }
            }, 300000);

            child.stdout.on('data', (data) => {
                socket.emit('output', data.toString());
            });

            child.stderr.on('data', (data) => {
                socket.emit('output', data.toString());
            });

            child.on('close', (code) => {
                clearTimeout(timer);
                socket.emit('exit', code);
                if (sessionDir && fs.existsSync(sessionDir)) {
                    fs.rmSync(sessionDir, { recursive: true, force: true });
                }
                child = null;
            });
        });
    });

    socket.on('input', (data) => {
        if (child && child.stdin.writable) {
            child.stdin.write(data);
        }
    });

    socket.on('disconnect', () => {
        if (child) child.kill();
        if (sessionDir && fs.existsSync(sessionDir)) {
            fs.rmSync(sessionDir, { recursive: true, force: true });
        }

        if (currentUserEmail) {
            const currentActive = activeUsers.get(currentUserEmail);
            // Only remove from global map if THIS connection is the one currently active
            if (currentActive && currentActive.socketId === socket.id) {
                activeUsers.delete(currentUserEmail);
                console.log(`[Presence] Student ${currentUserEmail} went offline.`);
                io.emit('admin-update-active', Array.from(activeUsers.values()));
            }
        }
    });
});


const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Backend server running on port ${PORT}`);
});

module.exports = {
    app,
    server,
    io
};
