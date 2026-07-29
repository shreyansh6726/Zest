const mongoose = require('mongoose');

const otpSchema = new mongoose.Schema({
    email: { type: String, required: true },
    otp: { type: String, required: true },
    batchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Batch', default: null },
    createdAt: { type: Date, default: Date.now, index: { expires: 300 } } // 5 minutes expiry
});

module.exports = mongoose.model('OTP', otpSchema);
