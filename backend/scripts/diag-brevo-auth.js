const SibApiV3Sdk = require('sib-api-v3-sdk');
require('dotenv').config();

const defaultClient = SibApiV3Sdk.ApiClient.instance;
console.log('Authentications keys:', Object.keys(defaultClient.authentications));

const apiKeyStr = process.env.BREVO_API_KEY;
console.log('API Key exists:', !!apiKeyStr);
if (apiKeyStr) {
    console.log('API Key prefix:', apiKeyStr.substring(0, 10));
}

// Try both common variants
if (defaultClient.authentications['api-key']) {
    console.log('Found "api-key"');
}
if (defaultClient.authentications['apiKey']) {
    console.log('Found "apiKey"');
}
