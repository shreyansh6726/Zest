const mongoose = require('mongoose');

const ExamSchema = new mongoose.Schema({
    testId: {
        type: String,
        required: true,
        unique: true
    },
    batchId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Batch',
        default: null
    },
    examName: {
        type: String,
        required: true
    },
    examDate: {
        type: Number, // Format: ddmmyyyy
        required: true
    },
    examTime: {
        type: Number, // Format: hhmmss
        required: true
    },
    duration: {
        type: Number, // In minutes
        required: true
    },
    topics: [{
        type: String
    }],
    totalMarks: {
        type: Number,
        required: true
    },
    passingMarks: {
        type: Number,
        required: true
    },
    status: {
        type: String,
        enum: ['scheduled', 'ongoing', 'completed', 'cancelled'],
        default: 'scheduled'
    },
    difficultyLevel: {
        type: String,
        enum: ['easy', 'medium', 'hard'],
        default: 'medium'
    }
}, { timestamps: true });

module.exports = mongoose.model('Exam', ExamSchema);
