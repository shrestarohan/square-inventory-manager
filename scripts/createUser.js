// scripts/createUser.js
require("../lib/loadEnv"); // adjust relative path

const bcrypt = require('bcryptjs');
const { Firestore } = require('@google-cloud/firestore');

(async () => {
  const firestore = new Firestore();

  const email = process.argv[2]?.toLowerCase();      // e.g. admin@yourco.com
  const username = process.argv[3]?.toLowerCase();   // e.g. admin
  const password = process.argv[4];                  // e.g. StrongPass123!

  if (!email || !username || !password) {
    console.log('Usage: node scripts/createUser.js <email> <username> <password>');
    process.exit(1);
  }

  const passwordHash = await bcrypt.hash(password, 12);

  await firestore.collection('users').doc(email).set({
    email,
    username,
    passwordHash,
    role: 'admin',
    createdAt: new Date().toISOString(),
  });

  console.log('Created user:', email);
  process.exit(0);
})();

//node scripts/createUser.js admin@yourco.com admin "StrongPass123!"
