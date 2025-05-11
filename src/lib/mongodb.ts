import { MongoClient } from 'mongodb';
import 'dotenv/config';

const uri = process.env.MONGODB_URI!;
const client = new MongoClient(uri);
export const db = client.db(process.env.MONGODB_DB || 'mandodb');