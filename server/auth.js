require('dotenv').config();

const driver = String(process.env.DB_DRIVER || 'mariadb').toLowerCase();

if (driver === 'sqlite') {
  module.exports = require('./auth-sqlite');
} else {
  module.exports = require('./auth-mariadb');
}
