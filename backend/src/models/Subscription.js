const mongoose = require('mongoose');

const SubscriptionSchema = new mongoose.Schema({
    studentEmail: {
        type: String,
        required: true,
        ref: 'Student'
    },
    subscription: {
        endpoint: String,
        expirationTime: Number,
        keys: {
            p256dh: String,
            auth: String
        }
    }
}, { timestamps: true });

module.exports = mongoose.model('Subscription', SubscriptionSchema);
