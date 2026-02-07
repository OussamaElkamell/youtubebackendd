require('dotenv').config();
const prisma = require('../services/prisma.service');
const { hashPassword } = require('../services/auth.service');

async function createAdmin() {
    const email = "AyoubAdmin@gmail.com";
    const password = "password123";
    const name = "Ayoub Admin";

    try {
        const existingUser = await prisma.user.findUnique({ where: { email } });
        if (existingUser) {
            console.log('User already exists');
            process.exit(0);
        }

        const hashedPassword = await hashPassword(password);
        const user = await prisma.user.create({
            data: {
                name,
                email,
                password: hashedPassword
            }
        });

        console.log('Admin user created successfully:', user.id);
        process.exit(0);
    } catch (error) {
        console.error('Error creating admin user:', error);
        process.exit(1);
    }
}

createAdmin();
