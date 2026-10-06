module.exports = {
  hashSync: (val, salt) => `mock_hash_${val}`,
  compareSync: (val, hash) => true,
  hash: async (val, salt) => `mock_hash_${val}`,
  compare: async (val, hash) => true,
  genSaltSync: () => 10,
  genSalt: async () => 10,
};
