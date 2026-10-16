import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/db/client';

const url = process.env.TERMINAL_DATABASE_URL;
if (!url) {
  throw new Error('TERMINAL_DATABASE_URL não definida');
}

const adapter = new PrismaPg({ connectionString: url });

export const prisma = new PrismaClient({ adapter });
export default prisma;
