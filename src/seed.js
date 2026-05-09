const bcrypt = require('bcryptjs');
const { readDb, writeDb, makeId } = require('./store');

function seedAdmin() {
  const data = readDb();
  const adminExists = data.users.some((u) => u.role === 'admin');

  if (adminExists) {
    return;
  }

  const username = process.env.DEFAULT_ADMIN_USERNAME || 'admin';
  const password = process.env.DEFAULT_ADMIN_PASSWORD || 'admin123';

  data.users.push({
    id: makeId('user'),
    name: 'Sistem Yonetici',
    username,
    passwordHash: bcrypt.hashSync(password, 10),
    role: 'admin',
    points: 0,
    createdAt: new Date().toISOString()
  });

  writeDb(data);

  console.log('Varsayilan admin olusturuldu:');
  console.log(`Kullanici: ${username}`);
  console.log(`Sifre: ${password}`);
}

module.exports = {
  seedAdmin
};
