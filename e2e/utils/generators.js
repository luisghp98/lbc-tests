const { faker } = require('@faker-js/faker');

/**
 * Genera datos aleatorios para un niño
 */
export function generateChildData() {
  const gender = faker.helpers.arrayElement(['male', 'female']);
  return {
    firstName: faker.person.firstName(gender),
    lastName: faker.person.lastName(),
    birthDate: faker.date.birthdate({ min: 0, max: 5, mode: 'age' }).toISOString().split('T')[0],
    gender,
    bloodType: faker.helpers.arrayElement(['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-']),
    allergies: faker.helpers.arrayElement([null, 'Peanuts', 'Lactose', 'Eggs', null, null]),
    medicalNotes: faker.helpers.arrayElement([faker.lorem.sentence(3), '']),
  };
}

export function generateClassroomData(overrides = {}) {
  return {
    name: overrides.name || faker.company.name() + ' Classroom',
    code: overrides.code || 'CLS-' + faker.string.alphanumeric(4).toUpperCase(),
    level: overrides.level || faker.helpers.arrayElement(['Infants', 'Toddlers', 'Pre-Kindergarten', 'Kindergarten', 'Advanced', 'Multi-Age']),
    size: overrides.size !== undefined ? overrides.size : faker.number.int({ min: 100, max: 1000 }),
    status: overrides.status || 'Active',
    building: overrides.building || faker.helpers.arrayElement(['Building A', 'Building B', 'Main Building']),
    floor: overrides.floor !== undefined ? overrides.floor : faker.number.int({ min: 1, max: 3 }),
    roomNumber: overrides.roomNumber || String(faker.number.int({ min: 100, max: 300 })),
    notes: overrides.notes || faker.lorem.sentence(),
  };
}

/**
 * Genera datos aleatorios para un representante
 */
export function generateRepresentativeData() {
  const relationship = faker.helpers.arrayElement(['mother', 'father', 'guardian', 'grandparent', 'aunt', 'uncle']);
  return {
    firstName: faker.person.firstName(),
    lastName: faker.person.lastName(),
    email: `test_e2e_${Date.now()}_${faker.string.alphanumeric(4)}@test.com`,
    phone: faker.string.numeric(10),
    relationship,
    city: faker.location.city(),
    idNumber: faker.string.numeric(10),
  };
}

/**
 * Genera datos para una escuela
 */
export function generateSchoolData() {
  const name = faker.company.name() + ' School';
  const code = 'SCH-' + faker.string.alphanumeric(4).toUpperCase();
  return {
    name,
    schoolCode: code,
    slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') + '-' + faker.string.alphanumeric(3).toLowerCase(),
    email: faker.internet.email({ provider: 'school.com' }),
    phone: '+1 ' + faker.string.numeric(10),
    website: `https://${name.toLowerCase().replace(/[^a-z0-9]+/g, '')}.com`,
  };
}

/**
 * Genera datos para una factura
 */
export function generateInvoiceData(familyId) {
  return {
    familyId,
    amount: parseFloat(faker.finance.amount({ min: 50, max: 500, dec: 2 })),
    dueDate: faker.date.future().toISOString().split('T')[0],
    description: faker.helpers.arrayElement(['Monthly Tuition', 'Enrollment Fee', 'Activity Fee', 'Material Fee']),
  };
}

/**
 * Genera datos para un aula (classroom)
 */
export function generateClassroomData(overrides = {}) {
  return {
    name: overrides.name || faker.company.name() + ' Classroom',
    code: overrides.code || 'CLS-' + faker.string.alphanumeric(4).toUpperCase(),
    level: overrides.level || faker.helpers.arrayElement(['Infants', 'Toddlers', 'Pre-Kindergarten', 'Kindergarten', 'Advanced', 'Multi-Age']),
    size: overrides.size !== undefined ? overrides.size : faker.number.int({ min: 100, max: 1000 }),
    status: overrides.status || 'Active',
    building: overrides.building || faker.helpers.arrayElement(['Building A', 'Building B', 'Main Building']),
    floor: overrides.floor !== undefined ? overrides.floor : faker.number.int({ min: 1, max: 3 }),
    roomNumber: overrides.roomNumber || String(faker.number.int({ min: 100, max: 300 })),
    notes: overrides.notes || faker.lorem.sentence(),
  };
}
