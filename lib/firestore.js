// lib/firestore.js
const { Firestore } = require('@google-cloud/firestore');

const options = {};

if (process.env.FIRESTORE_DATABASE_ID) {
  options.databaseId = process.env.FIRESTORE_DATABASE_ID;
  console.log('🔥 Using Firestore database:', options.databaseId);
} else {
  console.log('🔥 Using Firestore DEFAULT database');
}

const firestore = new Firestore(options);

module.exports = firestore;
