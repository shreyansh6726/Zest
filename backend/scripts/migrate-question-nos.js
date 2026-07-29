require('dotenv').config();
const mongoose = require('mongoose');
const TestContent = require('../src/models/TestContent');

const MONGO_URI = process.env.MONGO_URI;

const normalizeQuestionNos = (questions = []) => {
    return questions.map((question, index) => ({
        ...question,
        questionNo: Number.isFinite(Number(question?.questionNo)) ? Number(question.questionNo) : index + 1
    }));
};

async function main() {
    if (!MONGO_URI) {
        throw new Error('MONGO_URI is not set');
    }

    await mongoose.connect(MONGO_URI);

    const docs = await TestContent.find({}).lean(false);
    let updatedCount = 0;

    for (const doc of docs) {
        const questions = Array.isArray(doc.questions) ? doc.questions : [];
        const needsUpdate = questions.some((question, index) => Number(question?.questionNo) !== index + 1);

        if (!needsUpdate) {
            continue;
        }

        const normalizedQuestions = normalizeQuestionNos(questions);
        doc.questions = normalizedQuestions;
        await doc.save();
        updatedCount += 1;
        console.log(`Updated testId ${doc.testId} with ${normalizedQuestions.length} numbered questions.`);
    }

    console.log(`Migration complete. Updated ${updatedCount} test content document(s).`);
}

main()
    .then(() => mongoose.disconnect())
    .catch(async (err) => {
        console.error('Migration failed:', err);
        try {
            await mongoose.disconnect();
        } catch (disconnectErr) {
            console.error('Failed to disconnect cleanly:', disconnectErr);
        }
        process.exitCode = 1;
    });
