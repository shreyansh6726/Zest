const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
    type: {
        type: String,
        enum: ['late_entry'],
        required: true
    },
    studentId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Student',
        required: true
    },
    studentName: {
        type: String,
        required: true
    },
    studentEmail: {
        type: String,
        required: true
    },
    testId: {
        type: String,
        required: true
    },
    batchId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Batch',
        default: null
    },
    status: {
        type: String,
        enum: ['pending', 'allowed', 'denied'],
        default: 'pending'
    }
}, { timestamps: true });

module.exports = mongoose.model('Notification', notificationSchema);
