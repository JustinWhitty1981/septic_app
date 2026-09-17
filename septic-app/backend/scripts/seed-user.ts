/**
 * Create or reset a staff account. This is the only way to get an admin, on purpose.
 *
 * POST /api/auth/register is public and now always creates a `driver`, so it cannot
 * be used to bootstrap an administrator -- and it must never be able to. An admin
 * creation screen is the eventual replacement; until then this script is it.
 *
 *   npm run seed:user -- --email=owner@septic.test --role=admin \
 *                        --first=Jordan --last=Anderson
 *
 *   --password=...   supply your own; otherwise a strong one is generated and
 *                    printed once. It is never stored in plaintext or logged twice.
 *
 * Uses `pg` directly rather than the TypeORM DataSource, for the same reason the
 * migration runner does: seeding a login should not require every entity in src/models to
 * be loadable and every table it maps to to exist. Fewer moving parts between "the
 * database is up" and "there is somebody to log in as".
 */

import { Client } from 'pg';
import { randomBytes } from 'crypto';
import * as bcrypt from 'bcrypt';
import * as dotenv from 'dotenv';

dotenv.config();

const ROLES = ['admin', 'manager', 'driver', 'office'] as const;
type Role = typeof ROLES[number];

const SALT_ROUNDS = 12;

function flag(name: string): string | undefined {
    const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : undefined;
}

/**
 * 16 random bytes rendered as 16 groups of "symbol + lowercase + uppercase + digit",
 * so every character class the validator checks for is present by construction
 * rather than by luck.
 */
async function generatePassword(): Promise<string> {
    const symbols = '!@#$%^&*(),.?":{}|<>-';
    const bytes = randomBytes(32);
    let out = '';
    for (let i = 0; i < 16; i++) {
        const [a, b, c] = [bytes[i], bytes[i + 16], bytes[(i * 7) % 32]];
        out += symbols[a % symbols.length]
             + String.fromCharCode(97 + (b % 26))
             + String.fromCharCode(65 + (c % 26))
             + String(48 + ((a + b) % 10));
    }
    return out;
}

async function main(): Promise<number> {
    const email = flag('email');
    const role = flag('role') as Role | undefined;
    const first = flag('first');
    const last = flag('last');
    let password = flag('password');

    if (!email || !role || !first || !last) {
        console.error(
            'usage: npm run seed:user -- --email=... --role=admin|manager|driver|office '
            + '--first=... --last=... [--password=...]');
        return 2;
    }

    if (!ROLES.includes(role)) {
        console.error(`invalid role "${role}". Must be one of: ${ROLES.join(', ')}`);
        console.error('(the old role "technician" no longer exists; it became "driver")');
        return 2;
    }

    let generated = false;
    if (!password) {
        password = await generatePassword();
        generated = true;
    }

    const hash = await bcrypt.hash(password, SALT_ROUNDS);

    const client = new Client({
        host: process.env.DATABASE_HOST || 'localhost',
        port: parseInt(process.env.DATABASE_PORT || '5432', 10),
        database: process.env.DATABASE_NAME || 'septic',
        user: process.env.DATABASE_USER || 'septic_dev',
        password: process.env.DATABASE_PASSWORD || 'septic_dev_pw',
    });
    await client.connect();

    try {
        const existing = await client.query(
            'SELECT id, role FROM septic_app.users WHERE email = $1', [email]);

        if (existing.rowCount) {
            await client.query(
                `UPDATE septic_app.users
                    SET password_hash = $2, role = $3, is_active = true, updated_at = now()
                  WHERE email = $1`, [email, hash, role]);
            console.log(`reset password and role for ${email} (id ${existing.rows[0].id})`);
        } else {
            const ins = await client.query(
                `INSERT INTO septic_app.users
                     (email, password_hash, first_name, last_name, role, is_active)
                 VALUES ($1, $2, $3, $4, $5, true)
                 RETURNING id`, [email, hash, first, last, role]);
            console.log(`created ${email} (id ${ins.rows[0].id})`);
        }

        console.log(`  role     ${role}`);
        if (generated) {
            console.log(`  password ${password}`);
            console.log('  ^ shown once and not recoverable; change it after first login');
        }
        return 0;
    } finally {
        await client.end();
    }
}

main()
    .then((code) => process.exit(code))
    .catch((err) => {
        console.error('seed-user failed:', err.message || err);
        process.exit(1);
    });
