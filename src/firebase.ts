import { initializeApp } from 'firebase/app';
import {
  getFirestore,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  collection,
  query,
  where,
  getDocFromServer
} from 'firebase/firestore';
import firebaseConfig from '../firebase-applet-config.json';

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: null,
      email: null,
      emailVerified: null,
      isAnonymous: null,
      tenantId: null,
      providerInfo: []
    },
    operationType,
    path
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

// Connection test on initial boot as required by SKILL.md
export async function testConnection() {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error("Please check your Firebase configuration.");
    }
  }
}

export interface TokenItem {
  id: string; // The exact Firestore Document ID
  token: string;
  status: 'Aktif' | 'Nonaktif';
  created_at: string;
  last_ip?: string;
}

export async function verifyToken(inputToken: string): Promise<TokenItem | null> {
  const cleanInput = inputToken.trim().toUpperCase();
  const path = `tokens/${cleanInput}`;
  try {
    // 1. Check direct doc ID
    const docRef = doc(db, 'tokens', cleanInput);
    const snap = await getDoc(docRef);
    if (snap.exists()) {
      const data = snap.data();
      return {
        id: snap.id,
        token: data.token || snap.id,
        status: data.status || 'Aktif',
        created_at: data.created_at || '',
        last_ip: data.last_ip || ''
      };
    }

    // 2. Fallback query where token == cleanInput
    const colRef = collection(db, 'tokens');
    const q = query(colRef, where('token', '==', cleanInput));
    const querySnap = await getDocs(q);
    if (!querySnap.empty) {
      const docSnap = querySnap.docs[0];
      const data = docSnap.data();
      return {
        id: docSnap.id,
        token: data.token || docSnap.id,
        status: data.status || 'Aktif',
        created_at: data.created_at || '',
        last_ip: data.last_ip || ''
      };
    }

    return null;
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, path);
  }
}

export async function updateTokenLastIp(inputToken: string, ip: string): Promise<void> {
  const cleanInput = inputToken.trim().toUpperCase();
  const path = `tokens/${cleanInput}`;
  try {
    const docRef = doc(db, 'tokens', cleanInput);
    const snap = await getDoc(docRef);
    if (snap.exists()) {
      await updateDoc(docRef, { last_ip: ip });
      return;
    }

    // Fallback: search by token field
    const colRef = collection(db, 'tokens');
    const q = query(colRef, where('token', '==', cleanInput));
    const querySnap = await getDocs(q);
    for (const d of querySnap.docs) {
      await updateDoc(d.ref, { last_ip: ip });
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

export async function createToken(tokenId: string): Promise<TokenItem> {
  const cleanToken = tokenId.trim().toUpperCase();
  const path = `tokens/${cleanToken}`;
  try {
    const docRef = doc(db, 'tokens', cleanToken);
    const item: TokenItem = {
      id: cleanToken,
      token: cleanToken,
      status: 'Aktif',
      created_at: new Date().toISOString(),
      last_ip: 'Belum Login'
    };
    await setDoc(docRef, {
      token: cleanToken,
      status: 'Aktif',
      created_at: item.created_at,
      last_ip: item.last_ip
    });
    return item;
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, path);
  }
}

export async function listTokens(): Promise<TokenItem[]> {
  const path = 'tokens';
  try {
    const colRef = collection(db, 'tokens');
    const snap = await getDocs(colRef);
    const tokens: TokenItem[] = [];
    snap.forEach((docSnap) => {
      const data = docSnap.data();
      tokens.push({
        id: docSnap.id,
        token: data.token || docSnap.id,
        status: data.status || 'Aktif',
        created_at: data.created_at || '',
        last_ip: data.last_ip || 'Belum Login'
      });
    });
    // Sort by created_at descending
    tokens.sort((a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime());
    return tokens;
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, path);
  }
}

export async function removeToken(docIdOrToken: string): Promise<void> {
  const clean = docIdOrToken.trim();
  const path = `tokens/${clean}`;
  try {
    // 1. Try deleting directly by document ID
    const docRef = doc(db, 'tokens', clean);
    await deleteDoc(docRef);

    // 2. In case the document in Firestore was saved with a different ID but token field matches
    const colRef = collection(db, 'tokens');
    const q = query(colRef, where('token', '==', clean));
    const querySnap = await getDocs(q);
    for (const d of querySnap.docs) {
      if (d.id !== clean) {
        await deleteDoc(d.ref);
      }
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, path);
  }
}

// Expose on window for easy access in index.html
if (typeof window !== 'undefined') {
  (window as unknown as {
    EdukaraFirebase: {
      testConnection: typeof testConnection;
      verifyToken: typeof verifyToken;
      updateTokenLastIp: typeof updateTokenLastIp;
      createToken: typeof createToken;
      listTokens: typeof listTokens;
      removeToken: typeof removeToken;
    };
  }).EdukaraFirebase = {
    testConnection,
    verifyToken,
    updateTokenLastIp,
    createToken,
    listTokens,
    removeToken,
  };
}

// Run initial connection test
testConnection();
