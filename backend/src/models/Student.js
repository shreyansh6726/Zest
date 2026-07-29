const mongoose = require('mongoose');



const studentSchema = new mongoose.Schema({

    name: {
        type: String,
        required: true
    },

    emailID: {
        type: String,
        required: true,
        unique: true,
        match: [/^[a-zA-Z0-9._%+-]+@gmail\.com$/, 'Please fill a valid gmail address']
    },

    password: {
        type: String,
        required: false
    },

    profilePicture: {
        type: String,
        default: ''
    },

    batchId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Batch',
        default: null
    },

    scores: {
        type: [Number],
        default: []
    },

    testId: {
        type: [String],
        default: []
    },

    alarm: {
        type: [Number],
        default: []
    },

    activeAlarmByTest: {
        type: Map,
        of: Number,
        default: {}
    },

    yellowWarning: {
        type: [Number],
        default: []
    },

    activeYellowWarningByTest: {
        type: Map,
        of: Number,
        default: {}
    },

    wrongAnswers: {
        type: [{
            testId: {
                type: String,
                required: true
            },
            questionId: {
                type: mongoose.Schema.Types.ObjectId,
                required: true
            },
            questionNo: {
                type: Number,
                default: null
            },
            answer: {
                type: String,
                default: ''
            },
            recordedAt: {
                type: Date,
                default: Date.now
            }
        }],
        default: []
    },

}, { timestamps: true });

module.exports = mongoose.model('Student', studentSchema);

