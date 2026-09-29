import React, { useState, useEffect, useMemo, createContext, useContext } from 'react';
import { 
  Plus, 
  List, 
  Calculator, 
  ArrowRight, 
  X, 
  AlertCircle,
  ChevronDown,
  ChevronUp,
  UserPlus,
  MoreVertical,
  Pencil,
  Trash2,
  Cloud,
  CloudOff,
  RefreshCw,
  Download,
  CheckCircle2,
  Copy,
  Check,
  ExternalLink,
  ArrowRightLeft,
  Sparkles,
  Upload
} from 'lucide-react';
import { 
  collection, 
  doc, 
  setDoc, 
  deleteDoc, 
  onSnapshot, 
  arrayUnion, 
  writeBatch,
  getDocFromServer
} from 'firebase/firestore';
import { db } from './firebase.ts';

// Test initial connection per Firebase skill guidelines
async function testConnection() {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.warn('Firebase client operating in offline mode.');
    }
  }
}
testConnection();

export interface Expense {
  id: string;
  date: string;
  description: string;
  amount: number;
  paidBy: string;
  splitAmong: string[];
}

export interface SharedExpenseDetail extends Expense {
  splitAmount: number;
}

export interface MemberBalance {
  paid: number;
  share: number;
  net: number;
  details: {
    shared: SharedExpenseDetail[];
    paid: Expense[];
  };
}

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

export function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errMsg = error instanceof Error ? error.message : String(error);
  if (errMsg.toLowerCase().includes('permission') || errMsg.toLowerCase().includes('insufficient')) {
    const errInfo: FirestoreErrorInfo = {
      error: errMsg,
      authInfo: {},
      operationType,
      path,
    };
    console.error('Firestore Error: ', JSON.stringify(errInfo));
    throw new Error(JSON.stringify(errInfo));
  }
}

export interface Settlement {
  from: string;
  to: string;
  amount: number;
}

export type SyncStatus = 'synced' | 'syncing' | 'offline' | 'error';

interface AppContextType {
  expenses: Expense[];
  addExpense: (expense: Expense) => void;
  updateExpense: (expense: Expense) => void;
  deleteExpense: (id: string) => void;
  members: string[];
  addMember: (name: string) => void;
  syncStatus: SyncStatus;
  syncLocalDataToCloud: () => Promise<number>;
  lastSyncedTime: Date | null;
  importData: (rawInput: string) => Promise<{ expensesCount: number; membersCount: number }>;
  importSuccessMessage: string | null;
  clearImportSuccessMessage: () => void;
}

const DEFAULT_MEMBERS = [
  "Shan", "Hein Htet Zaw", "Lin Myat Oo", "Ko Zin", "Ko Zin Wife", 
  "Aung Thura", "San Yu", "Nay Lin Htet", "Aung Kyaw Thura", 
  "Ko Latt", "Aye Chan Aung", "Myint Myat Aung", "Hein Htoo Htoo Kyaw"
];

// Fallback ID generator if crypto is not available
const generateId = (): string => {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).substring(2, 15);
};

const formatDate = (dateStr: string): string => {
  const d = new Date(dateStr);
  return isNaN(d.getTime()) 
    ? dateStr 
    : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};

function useLocalStorage<T>(key: string, initialValue: T): [T, (value: T | ((val: T) => T)) => void] {
  const [storedValue, setStoredValue] = useState<T>(() => {
    try {
      const item = window.localStorage.getItem(key);
      return item ? JSON.parse(item) : initialValue;
    } catch (error) {
      console.error(`Error loading localStorage key "${key}":`, error);
      return initialValue;
    }
  });

  const setValue = (value: T | ((val: T) => T)) => {
    try {
      const valueToStore = value instanceof Function ? value(storedValue) : value;
      setStoredValue(valueToStore);
      window.localStorage.setItem(key, JSON.stringify(valueToStore));
    } catch (error) {
      console.error(`Error writing localStorage key "${key}":`, error);
    }
  };

  return [storedValue, setValue];
}

const AppContext = createContext<AppContextType | null>(null);

const AppProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [expenses, setExpenses] = useLocalStorage<Expense[]>('trip-expenses-v2', []);
  const [members, setMembers] = useLocalStorage<string[]>('trip-members-v1', DEFAULT_MEMBERS);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('syncing');
  const [lastSyncedTime, setLastSyncedTime] = useState<Date | null>(null);
  const [importSuccessMessage, setImportSuccessMessage] = useState<string | null>(null);

  const clearImportSuccessMessage = () => setImportSuccessMessage(null);

  // Import data handler (parses JSON, writes to Firestore & updates local storage)
  const importData = async (rawInput: string): Promise<{ expensesCount: number; membersCount: number }> => {
    let parsed: any;
    try {
      parsed = JSON.parse(rawInput.trim());
    } catch {
      throw new Error('ထည့်သွင်းထားသော စာရင်း format မမှန်ကန်ပါ။ ကျေးဇူးပြု၍ JSON data ကို သေချာစစ်ဆေးပေးပါ။');
    }

    let incomingExpenses: Expense[] = [];
    let incomingMembers: string[] = [];

    if (Array.isArray(parsed)) {
      incomingExpenses = parsed;
    } else if (parsed && typeof parsed === 'object') {
      if (Array.isArray(parsed.expenses)) {
        incomingExpenses = parsed.expenses;
      }
      if (Array.isArray(parsed.members)) {
        incomingMembers = parsed.members;
      }
    }

    if (incomingExpenses.length === 0 && incomingMembers.length === 0) {
      throw new Error('ထည့်သွင်းရန် စာရင်း (expenses) မတွေ့ရှိပါ။');
    }

    const validExpenses: Expense[] = incomingExpenses
      .filter(e => e && typeof e === 'object' && e.description && e.amount !== undefined)
      .map(e => ({
        id: e.id || generateId(),
        description: String(e.description || '').trim(),
        amount: Number(e.amount) || 0,
        date: e.date || new Date().toISOString().split('T')[0],
        paidBy: e.paidBy || DEFAULT_MEMBERS[0],
        splitAmong: Array.isArray(e.splitAmong) && e.splitAmong.length > 0 ? e.splitAmong : DEFAULT_MEMBERS,
      }));

    setSyncStatus('syncing');
    const batch = writeBatch(db);
    validExpenses.forEach(exp => {
      batch.set(doc(db, 'expenses', exp.id), exp, { merge: true });
    });

    let mergedMembers = members;
    if (incomingMembers.length > 0) {
      mergedMembers = Array.from(new Set([...members, ...incomingMembers]));
      batch.set(doc(db, 'trip_config', 'meta'), { members: mergedMembers }, { merge: true });
    }

    await batch.commit();

    if (validExpenses.length > 0) {
      setExpenses(prev => {
        const incomingIds = new Set(validExpenses.map(e => e.id));
        const combined = [...validExpenses, ...prev.filter(e => !incomingIds.has(e.id))];
        combined.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
        window.localStorage.setItem('trip-expenses-v2', JSON.stringify(combined));
        return combined;
      });
    }

    if (incomingMembers.length > 0) {
      setMembers(mergedMembers);
      window.localStorage.setItem('trip-members-v1', JSON.stringify(mergedMembers));
    }

    setSyncStatus('synced');
    setLastSyncedTime(new Date());

    return {
      expensesCount: validExpenses.length,
      membersCount: incomingMembers.length,
    };
  };

  // Auto-migration & real-time synchronization on mount
  useEffect(() => {
    let isSubscribed = true;

    // Check URL parameters and hash for migration data
    try {
      const urlParams = new URLSearchParams(window.location.search);
      let importParam = urlParams.get('import_data');
      if (!importParam && window.location.hash) {
        const hash = window.location.hash.substring(1);
        const hashParams = new URLSearchParams(hash);
        importParam = hashParams.get('import_data');
      }
      if (importParam) {
        const decodedStr = decodeURIComponent(importParam);
        importData(decodedStr).then(({ expensesCount }) => {
          setImportSuccessMessage(`Vercel မှ စာရင်း (${expensesCount}) ခုကို Cloud ပေါ်သို့ အောင်မြင်စွာ တင်သွင်းပြီးပါပြီ!`);
          window.history.replaceState({}, document.title, window.location.pathname);
        }).catch(err => {
          console.warn('URL auto-import error:', err);
        });
      }
    } catch (e) {
      console.warn('URL param parse error:', e);
    }

    // Expose console helper for quick manual import
    (window as any).importTripData = async (data: any) => {
      const input = typeof data === 'string' ? data : JSON.stringify(data);
      const res = await importData(input);
      console.log(`✅ Successfully imported ${res.expensesCount} expenses to Cloud Firestore!`);
      return res;
    };

    // 1. Initial migration: if local storage has any expenses, push them to Firestore
    const migrateLocalToCloud = async () => {
      try {
        const localRaw = window.localStorage.getItem('trip-expenses-v2');
        if (localRaw) {
          const localList: Expense[] = JSON.parse(localRaw);
          if (Array.isArray(localList) && localList.length > 0) {
            const batch = writeBatch(db);
            let count = 0;
            localList.forEach((exp) => {
              if (exp && exp.id) {
                const ref = doc(db, 'expenses', exp.id);
                batch.set(ref, exp, { merge: true });
                count++;
              }
            });
            if (count > 0) {
              await batch.commit();
              console.log(`Auto-migrated ${count} local expenses to cloud.`);
            }
          }
        }

        // Migrate custom members if any
        const localMemRaw = window.localStorage.getItem('trip-members-v1');
        if (localMemRaw) {
          const localMembers: string[] = JSON.parse(localMemRaw);
          if (Array.isArray(localMembers) && localMembers.length > 0) {
            const merged = Array.from(new Set([...DEFAULT_MEMBERS, ...localMembers]));
            await setDoc(doc(db, 'trip_config', 'meta'), { members: merged }, { merge: true });
          }
        }
      } catch (err) {
        console.warn('Initial cloud migration notice:', err);
      }
    };

    migrateLocalToCloud();

    // 2. Real-time expenses listener
    const unsubExpenses = onSnapshot(
      collection(db, 'expenses'),
      (snapshot) => {
        if (!isSubscribed) return;
        const cloudExpenses: Expense[] = [];
        snapshot.forEach((docSnap) => {
          const data = docSnap.data() as Expense;
          if (data && data.id) {
            cloudExpenses.push({
              id: data.id || docSnap.id,
              date: data.date || new Date().toISOString().split('T')[0],
              description: data.description || 'Expense',
              amount: Number(data.amount) || 0,
              paidBy: data.paidBy || DEFAULT_MEMBERS[0],
              splitAmong: Array.isArray(data.splitAmong) ? data.splitAmong : [],
            });
          }
        });

        // Ensure any locally cached expenses not yet present in snapshot get uploaded
        try {
          const localRaw = window.localStorage.getItem('trip-expenses-v2');
          if (localRaw) {
            const localList: Expense[] = JSON.parse(localRaw);
            if (Array.isArray(localList) && localList.length > 0) {
              const cloudIds = new Set(cloudExpenses.map(e => e.id));
              const missingInCloud = localList.filter(e => !cloudIds.has(e.id));
              if (missingInCloud.length > 0) {
                missingInCloud.forEach(exp => {
                  setDoc(doc(db, 'expenses', exp.id), exp, { merge: true }).catch(console.error);
                  cloudExpenses.push(exp);
                });
              }
            }
          }
        } catch {}

        // Sort descending by date
        cloudExpenses.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

        setExpenses(cloudExpenses);
        window.localStorage.setItem('trip-expenses-v2', JSON.stringify(cloudExpenses));
        setSyncStatus('synced');
        setLastSyncedTime(new Date());
      },
      (error) => {
        handleFirestoreError(error, OperationType.LIST, 'expenses');
        setSyncStatus('offline');
      }
    );

    // 3. Real-time trip members listener
    const unsubMembers = onSnapshot(
      doc(db, 'trip_config', 'meta'),
      (docSnap) => {
        if (!isSubscribed) return;
        if (docSnap.exists()) {
          const data = docSnap.data();
          if (Array.isArray(data.members) && data.members.length > 0) {
            const merged = Array.from(new Set([...DEFAULT_MEMBERS, ...data.members]));
            setMembers(merged);
            window.localStorage.setItem('trip-members-v1', JSON.stringify(merged));
            return;
          }
        }
        // Initialize doc in cloud if missing
        setDoc(doc(db, 'trip_config', 'meta'), { members: DEFAULT_MEMBERS }, { merge: true }).catch(console.error);
      },
      (error) => {
        handleFirestoreError(error, OperationType.GET, 'trip_config/meta');
      }
    );

    return () => {
      isSubscribed = false;
      unsubExpenses();
      unsubMembers();
    };
  }, []);

  const addExpense = async (expense: Expense) => {
    // Optimistic local update
    setExpenses(prev => [expense, ...prev.filter(e => e.id !== expense.id)]);
    try {
      setSyncStatus('syncing');
      await setDoc(doc(db, 'expenses', expense.id), expense);
      setSyncStatus('synced');
      setLastSyncedTime(new Date());
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, `expenses/${expense.id}`);
      setSyncStatus('offline');
    }
  };

  const updateExpense = async (expense: Expense) => {
    // Optimistic local update
    setExpenses(prev => prev.map(e => e.id === expense.id ? expense : e));
    try {
      setSyncStatus('syncing');
      await setDoc(doc(db, 'expenses', expense.id), expense, { merge: true });
      setSyncStatus('synced');
      setLastSyncedTime(new Date());
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `expenses/${expense.id}`);
      setSyncStatus('offline');
    }
  };

  const deleteExpense = async (id: string) => {
    // Optimistic local update
    setExpenses(prev => prev.filter(e => e.id !== id));
    try {
      setSyncStatus('syncing');
      await deleteDoc(doc(db, 'expenses', id));
      setSyncStatus('synced');
      setLastSyncedTime(new Date());
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `expenses/${id}`);
      setSyncStatus('offline');
    }
  };

  const addMember = async (name: string) => {
    const trimmed = name.trim();
    if (trimmed && !members.includes(trimmed)) {
      setMembers(prev => [...prev, trimmed]);
      try {
        await setDoc(doc(db, 'trip_config', 'meta'), { members: arrayUnion(trimmed) }, { merge: true });
      } catch (err) {
        handleFirestoreError(err, OperationType.UPDATE, 'trip_config/meta');
      }
    }
  };

  // Manual trigger to re-sync all local storage data to cloud
  const syncLocalDataToCloud = async (): Promise<number> => {
    setSyncStatus('syncing');
    try {
      const localRaw = window.localStorage.getItem('trip-expenses-v2');
      const localList: Expense[] = localRaw ? JSON.parse(localRaw) : expenses;
      let count = 0;
      for (const exp of localList) {
        if (exp && exp.id) {
          await setDoc(doc(db, 'expenses', exp.id), exp, { merge: true });
          count++;
        }
      }
      await setDoc(doc(db, 'trip_config', 'meta'), { members }, { merge: true });
      setSyncStatus('synced');
      setLastSyncedTime(new Date());
      return count;
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, 'expenses');
      setSyncStatus('offline');
      throw err;
    }
  };

  return (
    <AppContext.Provider value={{ 
      expenses, 
      addExpense, 
      updateExpense, 
      deleteExpense, 
      members, 
      addMember,
      syncStatus,
      syncLocalDataToCloud,
      lastSyncedTime,
      importData,
      importSuccessMessage,
      clearImportSuccessMessage
    }}>
      {children}
    </AppContext.Provider>
  );
};

// Core logic to calculate who owes who and the minimum transactions to settle
const calculateBalancesAndSettlements = (expenses: Expense[], members: string[]) => {
  const balances: Record<string, MemberBalance> = {};
  members.forEach(m => {
    balances[m] = { 
      paid: 0, 
      share: 0, 
      net: 0, 
      details: { shared: [], paid: [] } 
    };
  });

  let totalSpent = 0;

  expenses.forEach(exp => {
    const amt = Number(exp.amount) || 0;
    totalSpent += amt;
    
    if (balances[exp.paidBy]) {
      balances[exp.paidBy].paid += amt;
      balances[exp.paidBy].details.paid.push(exp);
    }

    if (exp.splitAmong && exp.splitAmong.length > 0) {
      const splitAmount = amt / exp.splitAmong.length;
      exp.splitAmong.forEach(m => {
        if (balances[m]) {
          balances[m].share += splitAmount;
          balances[m].details.shared.push({ ...exp, splitAmount });
        }
      });
    }
  });

  members.forEach(m => {
    if (balances[m]) {
      balances[m].net = balances[m].paid - balances[m].share;
    }
  });

  const settlements: Settlement[] = [];
  const CENTRAL_PERSON = "Shan";

  // Everyone who owes money pays Shan, and Shan pays everyone who is owed money
  members.forEach(m => {
    if (m === CENTRAL_PERSON || !balances[m]) return;

    const net = balances[m].net;
    // Using a tiny epsilon to avoid floating point precision issues
    if (net < -0.01) {
      // This person owes money -> Pay to Shan
      settlements.push({
        from: m,
        to: CENTRAL_PERSON,
        amount: -net
      });
    } else if (net > 0.01) {
      // This person is owed money -> Shan pays them
      settlements.push({
        from: CENTRAL_PERSON,
        to: m,
        amount: net
      });
    }
  });

  return { balances, settlements, totalSpent };
};

const AddExpenseForm: React.FC<{ onSave: () => void }> = ({ onSave }) => {
  const context = useContext(AppContext);
  if (!context) throw new Error("AddExpenseForm must be used within AppProvider");
  const { addExpense, members, addMember } = context;

  const [date, setDate] = useState(() => new Date().toISOString().split('T')[0]);
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [paidBy, setPaidBy] = useState(members[0] || 'Shan');
  const [splitAmong, setSplitAmong] = useState<string[]>(members); // Default to all
  const [error, setError] = useState('');
  const [newMemberName, setNewMemberName] = useState('');

  // Update default payer if members list changes
  useEffect(() => {
    if (!members.includes(paidBy) && members.length > 0) {
      setPaidBy(members[0]);
    }
  }, [members, paidBy]);

  const toggleMember = (member: string) => {
    setSplitAmong(prev => 
      prev.includes(member) ? prev.filter(m => m !== member) : [...prev, member]
    );
  };

  const selectAll = () => setSplitAmong([...members]);
  const deselectAll = () => setSplitAmong([]);

  const handleAddNewMember = () => {
    const trimmed = newMemberName.trim();
    if (trimmed && !members.includes(trimmed)) {
      addMember(trimmed);
      setSplitAmong(prev => [...prev, trimmed]);
      setNewMemberName('');
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const parsedAmount = parseFloat(amount);
    if (!description.trim() || isNaN(parsedAmount) || parsedAmount <= 0 || splitAmong.length === 0) {
      setError('Please provide a description, valid amount, and select at least one person.');
      return;
    }
    
    setError('');
    
    const newExpense: Expense = {
      id: generateId(),
      date,
      description: description.trim(),
      amount: parsedAmount,
      paidBy,
      splitAmong
    };

    addExpense(newExpense);
    
    // Reset core fields for next entry
    setDescription('');
    setAmount('');
    onSave(); // Navigate to list view
  };

  return (
    <div className="max-w-md mx-auto fade-in">
      <h2 className="text-xl font-medium text-gray-900 mb-6">New Expense</h2>
      
      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Basic Info */}
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
            <input 
              type="text" 
              placeholder="e.g. Dinner, Taxi, Hotel..." 
              value={description} 
              onChange={e => setDescription(e.target.value)}
              className="w-full px-4 py-2 bg-gray-50 border border-gray-200 rounded-lg focus:outline-none focus:border-gray-400 focus:bg-white transition-colors" 
            />
          </div>

          <div className="flex gap-4">
            <div className="flex-1">
              <label className="block text-sm font-medium text-gray-700 mb-1">Amount</label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 font-medium">฿</span>
                <input 
                  type="number" 
                  min="0.01" 
                  step="0.01" 
                  placeholder="0.00" 
                  value={amount} 
                  onChange={e => setAmount(e.target.value)}
                  className="w-full pl-8 pr-4 py-2 bg-gray-50 border border-gray-200 rounded-lg focus:outline-none focus:border-gray-400 focus:bg-white transition-colors" 
                />
              </div>
            </div>
            <div className="flex-1">
              <label className="block text-sm font-medium text-gray-700 mb-1">Date</label>
              <input 
                type="date" 
                value={date} 
                onChange={e => setDate(e.target.value)}
                className="w-full px-4 py-2 bg-gray-50 border border-gray-200 rounded-lg focus:outline-none focus:border-gray-400 focus:bg-white transition-colors" 
              />
            </div>
          </div>
        </div>

        {/* Payer */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Paid by</label>
          <div className="relative">
            <select 
              value={paidBy} 
              onChange={e => setPaidBy(e.target.value)}
              className="w-full px-4 py-2 bg-gray-50 border border-gray-200 rounded-lg focus:outline-none focus:border-gray-400 focus:bg-white transition-colors appearance-none cursor-pointer pr-10"
            >
              {members.map(m => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
            <ChevronDown className="w-4 h-4 text-gray-400 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          </div>
        </div>

        {/* Split Among */}
        <div>
          <div className="flex justify-between items-center mb-2">
            <label className="block text-sm font-medium text-gray-700">
              Split between ({splitAmong.length})
            </label>
            <div className="space-x-3 text-sm">
              <button 
                type="button" 
                onClick={selectAll} 
                className="text-gray-500 hover:text-gray-900 cursor-pointer font-medium"
              >
                All
              </button>
              <button 
                type="button" 
                onClick={deselectAll} 
                className="text-gray-500 hover:text-gray-900 cursor-pointer font-medium"
              >
                None
              </button>
            </div>
          </div>
          
          <div className="flex flex-wrap gap-2 mb-3">
            {members.map(member => (
              <button
                key={member}
                type="button"
                onClick={() => toggleMember(member)}
                className={`px-3 py-1.5 rounded-full text-sm transition-colors border cursor-pointer ${
                  splitAmong.includes(member) 
                    ? 'bg-gray-900 text-white border-gray-900 font-medium shadow-xs' 
                    : 'bg-white text-gray-600 border-gray-200 hover:border-gray-300'
                }`}
              >
                {member}
              </button>
            ))}
          </div>

          {/* Add New Person Inline */}
          <div className="flex gap-2">
            <input 
              type="text" 
              placeholder="Add new person..." 
              value={newMemberName} 
              onChange={e => setNewMemberName(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleAddNewMember();
                }
              }}
              className="flex-1 px-3 py-1.5 text-sm bg-gray-50 border border-gray-200 rounded-lg focus:outline-none focus:border-gray-400 focus:bg-white transition-colors"
            />
            <button 
              type="button" 
              onClick={handleAddNewMember}
              disabled={!newMemberName.trim()}
              className="px-3 py-1.5 bg-gray-100 hover:bg-gray-200 text-gray-700 text-sm font-medium rounded-lg transition-colors disabled:opacity-50 cursor-pointer"
            >
              Add
            </button>
          </div>
        </div>

        {error && (
          <div className="p-3 bg-red-50 text-red-600 rounded-lg text-sm flex items-center">
            <AlertCircle className="w-4 h-4 mr-2 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <button 
          type="submit" 
          className="w-full bg-gray-900 hover:bg-gray-800 text-white font-medium py-3 rounded-lg transition-colors flex justify-center items-center cursor-pointer shadow-xs"
        >
          Save Expense
        </button>
      </form>
    </div>
  );
};

const EditExpenseModal: React.FC<{
  expense: Expense;
  onClose: () => void;
  onSave: (updated: Expense) => void;
  members: string[];
  addMember: (name: string) => void;
}> = ({ expense, onClose, onSave, members, addMember }) => {
  const [description, setDescription] = useState(expense.description);
  const [amount, setAmount] = useState(expense.amount.toString());
  const [date, setDate] = useState(expense.date);
  const [paidBy, setPaidBy] = useState(expense.paidBy);
  const [splitAmong, setSplitAmong] = useState<string[]>(expense.splitAmong);
  const [error, setError] = useState('');
  const [newMemberName, setNewMemberName] = useState('');

  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const toggleMember = (member: string) => {
    setSplitAmong(prev => 
      prev.includes(member) ? prev.filter(m => m !== member) : [...prev, member]
    );
  };

  const selectAll = () => setSplitAmong([...members]);
  const deselectAll = () => setSplitAmong([]);

  const handleAddNewMember = () => {
    const trimmed = newMemberName.trim();
    if (trimmed && !members.includes(trimmed)) {
      addMember(trimmed);
      setSplitAmong(prev => [...prev, trimmed]);
      setNewMemberName('');
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const parsedAmount = parseFloat(amount);
    if (!description.trim() || isNaN(parsedAmount) || parsedAmount <= 0 || splitAmong.length === 0) {
      setError('Please provide a description, valid amount, and select at least one person.');
      return;
    }

    onSave({
      ...expense,
      description: description.trim(),
      amount: parsedAmount,
      date,
      paidBy,
      splitAmong,
    });
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-xs">
      {/* Backdrop */}
      <div className="fixed inset-0" onClick={onClose} />

      <div className="relative bg-white rounded-2xl shadow-xl max-w-md w-full max-h-[90vh] overflow-y-auto z-10 p-6 fade-in border border-gray-100">
        <div className="flex justify-between items-center mb-5 pb-3 border-b border-gray-100">
          <div>
            <h3 className="text-lg font-semibold text-gray-900">Edit Expense</h3>
            <p className="text-xs text-gray-500">Update expense details and split configuration</p>
          </div>
          <button 
            type="button" 
            onClick={onClose} 
            className="p-1.5 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100 transition-colors cursor-pointer"
            title="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          {/* Basic Info */}
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
              <input 
                type="text" 
                placeholder="e.g. Dinner, Taxi, Hotel..." 
                value={description} 
                onChange={e => setDescription(e.target.value)}
                className="w-full px-4 py-2 bg-gray-50 border border-gray-200 rounded-lg focus:outline-none focus:border-gray-400 focus:bg-white transition-colors text-sm" 
              />
            </div>

            <div className="flex gap-4">
              <div className="flex-1">
                <label className="block text-sm font-medium text-gray-700 mb-1">Amount</label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 font-medium text-sm">฿</span>
                  <input 
                    type="number" 
                    min="0.01" 
                    step="0.01" 
                    placeholder="0.00" 
                    value={amount} 
                    onChange={e => setAmount(e.target.value)}
                    className="w-full pl-8 pr-4 py-2 bg-gray-50 border border-gray-200 rounded-lg focus:outline-none focus:border-gray-400 focus:bg-white transition-colors text-sm" 
                  />
                </div>
              </div>
              <div className="flex-1">
                <label className="block text-sm font-medium text-gray-700 mb-1">Date</label>
                <input 
                  type="date" 
                  value={date} 
                  onChange={e => setDate(e.target.value)}
                  className="w-full px-4 py-2 bg-gray-50 border border-gray-200 rounded-lg focus:outline-none focus:border-gray-400 focus:bg-white transition-colors text-sm" 
                />
              </div>
            </div>
          </div>

          {/* Payer */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Paid by</label>
            <div className="relative">
              <select 
                value={paidBy} 
                onChange={e => setPaidBy(e.target.value)}
                className="w-full px-4 py-2 bg-gray-50 border border-gray-200 rounded-lg focus:outline-none focus:border-gray-400 focus:bg-white transition-colors appearance-none cursor-pointer pr-10 text-sm"
              >
                {members.map(m => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
              <ChevronDown className="w-4 h-4 text-gray-400 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            </div>
          </div>

          {/* Split Among */}
          <div>
            <div className="flex justify-between items-center mb-2">
              <label className="block text-sm font-medium text-gray-700">
                Split between ({splitAmong.length})
              </label>
              <div className="space-x-3 text-xs">
                <button 
                  type="button" 
                  onClick={selectAll} 
                  className="text-gray-500 hover:text-gray-900 cursor-pointer font-medium"
                >
                  All
                </button>
                <button 
                  type="button" 
                  onClick={deselectAll} 
                  className="text-gray-500 hover:text-gray-900 cursor-pointer font-medium"
                >
                  None
                </button>
              </div>
            </div>
            
            <div className="flex flex-wrap gap-1.5 mb-3 max-h-36 overflow-y-auto p-1 border border-gray-100 rounded-lg bg-gray-50/50">
              {members.map(member => (
                <button
                  key={member}
                  type="button"
                  onClick={() => toggleMember(member)}
                  className={`px-2.5 py-1 rounded-full text-xs transition-colors border cursor-pointer ${
                    splitAmong.includes(member) 
                      ? 'bg-gray-900 text-white border-gray-900 font-medium shadow-xs' 
                      : 'bg-white text-gray-600 border-gray-200 hover:border-gray-300'
                  }`}
                >
                  {member}
                </button>
              ))}
            </div>

            {/* Add New Person Inline */}
            <div className="flex gap-2">
              <input 
                type="text" 
                placeholder="Add new person..." 
                value={newMemberName} 
                onChange={e => setNewMemberName(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleAddNewMember();
                  }
                }}
                className="flex-1 px-3 py-1.5 text-xs bg-gray-50 border border-gray-200 rounded-lg focus:outline-none focus:border-gray-400 focus:bg-white transition-colors"
              />
              <button 
                type="button" 
                onClick={handleAddNewMember}
                disabled={!newMemberName.trim()}
                className="px-3 py-1.5 bg-gray-100 hover:bg-gray-200 text-gray-700 text-xs font-medium rounded-lg transition-colors disabled:opacity-50 cursor-pointer"
              >
                Add
              </button>
            </div>
          </div>

          {error && (
            <div className="p-3 bg-red-50 text-red-600 rounded-lg text-sm flex items-center">
              <AlertCircle className="w-4 h-4 mr-2 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div className="flex gap-3 pt-2">
            <button 
              type="button" 
              onClick={onClose}
              className="flex-1 bg-gray-100 hover:bg-gray-200 text-gray-700 font-medium py-2.5 rounded-lg transition-colors cursor-pointer text-sm"
            >
              Cancel
            </button>
            <button 
              type="submit" 
              className="flex-1 bg-gray-900 hover:bg-gray-800 text-white font-medium py-2.5 rounded-lg transition-colors cursor-pointer text-sm shadow-xs"
            >
              Save Changes
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

const ExpenseList: React.FC<{ onOpenVercelModal?: () => void }> = ({ onOpenVercelModal }) => {
  const context = useContext(AppContext);
  if (!context) throw new Error("ExpenseList must be used within AppProvider");
  const { expenses, updateExpense, deleteExpense, members, addMember } = context;

  const [deletePendingId, setDeletePendingId] = useState<string | null>(null);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [editingExpense, setEditingExpense] = useState<Expense | null>(null);

  if (expenses.length === 0) {
    return (
      <div className="max-w-md mx-auto py-8 px-4 text-center fade-in">
        <div className="w-12 h-12 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-3 text-gray-400">
          <List className="w-6 h-6" />
        </div>
        <h3 className="text-base font-medium text-gray-900 mb-1">No expenses yet</h3>
        <p className="text-xs text-gray-500 mb-6">Add your first expense to begin tracking.</p>

        {/* Vercel Import Card */}
        {onOpenVercelModal && (
          <div className="bg-amber-50/90 border border-amber-200/90 rounded-2xl p-4 text-left shadow-xs">
            <div className="flex items-start gap-3">
              <div className="p-2 bg-amber-100 text-amber-800 rounded-xl shrink-0 mt-0.5">
                <ArrowRightLeft className="w-4 h-4" />
              </div>
              <div className="flex-1">
                <h4 className="text-xs font-semibold text-amber-950 mb-1">
                  trip-alpha-nine.vercel.app တွင် ဖြည့်ထားသော စာရင်းများရှိပါသလား?
                </h4>
                <p className="text-[11px] text-amber-800 leading-relaxed mb-3">
                  သင်တို့ ယခင် Vercel တွင် ဖြည့်သွင်းထားသော စာရင်းများသည် မပျောက်မပျက် ရှိနေပါသည်။ ၎င်းတို့ကို ဤ Firebase Cloud Database စနစ်ထဲသို့ ၁ စက္ကန့်အတွင်း အလွယ်တကူ ပြောင်းရွှေ့နိုင်ပါသည်။
                </p>
                <button
                  type="button"
                  onClick={onOpenVercelModal}
                  className="bg-amber-900 hover:bg-amber-950 text-white text-xs font-medium px-3.5 py-2 rounded-xl transition-colors flex items-center gap-1.5 cursor-pointer shadow-xs"
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  <span>Vercel မှ Data များ ပြောင်းရွှေ့ရန် နှိပ်ပါ</span>
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="max-w-lg mx-auto fade-in">
      <div className="flex justify-between items-center mb-6">
        <div className="flex items-center gap-2">
          <h2 className="text-xl font-medium text-gray-900">History</h2>
          <span className="text-xs text-gray-500 font-medium bg-gray-100 px-2.5 py-1 rounded-full">
            {expenses.length} {expenses.length === 1 ? 'item' : 'items'}
          </span>
        </div>

        {onOpenVercelModal && (
          <button
            type="button"
            onClick={onOpenVercelModal}
            className="text-xs text-amber-800 bg-amber-50 hover:bg-amber-100 border border-amber-200 font-medium flex items-center gap-1.5 px-2.5 py-1 rounded-lg transition-colors cursor-pointer"
            title="Import from trip-alpha-nine.vercel.app"
          >
            <ArrowRightLeft className="w-3 h-3 text-amber-700" />
            <span>Import Vercel</span>
          </button>
        )}
      </div>

      <div className="space-y-3">
        {expenses.map((exp) => (
          <div 
            key={exp.id} 
            className="bg-white p-4 rounded-xl border border-gray-100 shadow-xs flex justify-between items-center group hover:border-gray-200 transition-colors relative"
          >
            <div className="flex-1 min-w-0 pr-4">
              <div className="flex items-center gap-2 mb-1">
                <span className="font-medium text-gray-900 truncate">{exp.description}</span>
                <span className="text-xs text-gray-400 whitespace-nowrap">{formatDate(exp.date)}</span>
              </div>
              
              <div className="text-sm text-gray-500 truncate">
                <span className="font-medium text-gray-700">{exp.paidBy}</span> paid
                <span className="mx-1.5">•</span>
                Split {exp.splitAmong.length === members.length ? 'evenly' : `with ${exp.splitAmong.length}`}
              </div>
            </div>
            
            <div className="flex items-center gap-3">
              <span className="font-medium text-gray-900 whitespace-nowrap">
                ฿{exp.amount.toFixed(2)}
              </span>

              {deletePendingId === exp.id ? (
                <div className="flex items-center gap-1.5 bg-red-50 p-1 rounded-lg border border-red-100 fade-in">
                  <button 
                    onClick={() => {
                      deleteExpense(exp.id);
                      setDeletePendingId(null);
                    }} 
                    className="text-xs bg-red-600 hover:bg-red-700 text-white px-2 py-1 rounded font-medium transition-colors cursor-pointer"
                  >
                    Delete
                  </button>
                  <button 
                    onClick={() => setDeletePendingId(null)}
                    className="text-xs text-gray-500 hover:text-gray-700 px-1.5 py-1 rounded cursor-pointer"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <div className="relative">
                  <button 
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setOpenMenuId(openMenuId === exp.id ? null : exp.id);
                    }} 
                    className={`p-1.5 rounded-lg transition-colors cursor-pointer ${
                      openMenuId === exp.id 
                        ? 'bg-gray-100 text-gray-900' 
                        : 'text-gray-400 hover:text-gray-700 hover:bg-gray-50'
                    }`}
                    title="Quick actions"
                    aria-label="Quick actions"
                  >
                    <MoreVertical className="w-4 h-4" />
                  </button>

                  {openMenuId === exp.id && (
                    <>
                      <div 
                        className="fixed inset-0 z-20" 
                        onClick={() => setOpenMenuId(null)} 
                      />
                      <div className="absolute right-0 top-full mt-1.5 w-36 bg-white rounded-xl shadow-lg border border-gray-100 py-1.5 z-30 fade-in text-sm">
                        <button
                          type="button"
                          onClick={() => {
                            setOpenMenuId(null);
                            setEditingExpense(exp);
                          }}
                          className="w-full px-3 py-2 text-left text-gray-700 hover:bg-gray-50 flex items-center gap-2 transition-colors cursor-pointer"
                        >
                          <Pencil className="w-3.5 h-3.5 text-gray-500" />
                          <span>Edit</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setOpenMenuId(null);
                            setDeletePendingId(exp.id);
                          }}
                          className="w-full px-3 py-2 text-left text-red-600 hover:bg-red-50 flex items-center gap-2 transition-colors cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5 text-red-500" />
                          <span>Delete</span>
                        </button>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {editingExpense && (
        <EditExpenseModal
          expense={editingExpense}
          onClose={() => setEditingExpense(null)}
          onSave={updateExpense}
          members={members}
          addMember={addMember}
        />
      )}
    </div>
  );
};

const BalancesDashboard: React.FC = () => {
  const context = useContext(AppContext);
  if (!context) throw new Error("BalancesDashboard must be used within AppProvider");
  const { expenses, members, addMember } = context;

  const [expandedMember, setExpandedMember] = useState<string | null>(null);
  const [newMemberName, setNewMemberName] = useState('');
  
  const { balances, settlements, totalSpent } = useMemo(() => {
    return calculateBalancesAndSettlements(expenses, members);
  }, [expenses, members]);

  const handleAddNewMember = (e: React.FormEvent) => {
    e.preventDefault();
    if (newMemberName.trim()) {
      addMember(newMemberName.trim());
      setNewMemberName('');
    }
  };

  return (
    <div className="max-w-lg mx-auto fade-in">
      <div className="mb-8 text-center bg-gray-50/70 p-6 rounded-2xl border border-gray-100">
        <span className="text-xs font-semibold uppercase tracking-wider text-gray-500 block mb-1">Total Trip Cost</span>
        <span className="text-4xl font-semibold text-gray-900 tracking-tight">฿{totalSpent.toFixed(2)}</span>
      </div>

      <div className="mb-10">
        <div className="flex justify-between items-baseline mb-4">
          <h2 className="text-xl font-medium text-gray-900">Settlements</h2>
          <span className="text-xs text-gray-500">Hub: Shan</span>
        </div>
        
        {settlements.length === 0 ? (
          <div className="p-8 text-center text-gray-500 bg-gray-50 rounded-xl border border-gray-100">
            All settled up. No pending balances.
          </div>
        ) : (
          <div className="space-y-2">
            {settlements.map((tx, idx) => (
              <div 
                key={idx} 
                className="p-3.5 bg-white border border-gray-100 rounded-xl flex items-center justify-between shadow-xs hover:border-gray-200 transition-colors"
              >
                <div className="flex items-center gap-3">
                  <span className="font-medium text-gray-900">{tx.from}</span>
                  <ArrowRight className="w-4 h-4 text-gray-400 shrink-0" />
                  <span className="font-medium text-gray-900">{tx.to}</span>
                </div>
                <div className="font-semibold text-gray-900">
                  ฿{tx.amount.toFixed(2)}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="mb-8">
        <h2 className="text-xl font-medium text-gray-900 mb-4 flex items-center justify-between">
          <span>Balances & Details</span>
          <span className="text-xs font-normal text-gray-500 bg-gray-100 px-2 py-1 rounded">Tap a name for details</span>
        </h2>
        <div className="space-y-1">
          {members.map(member => {
            const b = balances[member];
            if (!b || (b.paid === 0 && b.share === 0)) return null; // Hide inactive members for cleanliness
            
            const isOwed = b.net > 0.01;
            const owes = b.net < -0.01;
            const isExpanded = expandedMember === member;

            return (
              <div key={member} className="border-b border-gray-100 last:border-0">
                <div 
                  onClick={() => setExpandedMember(isExpanded ? null : member)}
                  className="flex justify-between items-center py-3 cursor-pointer hover:bg-gray-50 -mx-2 px-2 rounded-lg transition-colors group"
                >
                  <div className="flex flex-col">
                    <div className="flex items-center gap-1.5">
                      <span className="font-medium text-gray-900">{member}</span>
                      {isExpanded ? (
                        <ChevronUp className="w-4 h-4 text-gray-400" />
                      ) : (
                        <ChevronDown className="w-4 h-4 text-gray-400 opacity-60 group-hover:opacity-100 transition-opacity" />
                      )}
                    </div>
                    <span className="text-xs text-gray-500">
                      Paid ฿{b.paid.toFixed(0)} • Share ฿{b.share.toFixed(0)}
                    </span>
                  </div>
                  
                  <div className={`font-semibold ${
                      isOwed ? 'text-green-600' : 
                      owes ? 'text-gray-900' : 
                      'text-gray-400'
                  }`}>
                    {isOwed ? '+฿' : owes ? '-฿' : '฿'}{Math.abs(b.net).toFixed(2)}
                  </div>
                </div>

                {/* Expanded Breakdown */}
                {isExpanded && (
                  <div className="pb-4 px-2 text-sm fade-in">
                    <div className="bg-gray-50 rounded-xl p-3.5 space-y-3 border border-gray-100">
                      {b.details.shared.length > 0 && (
                        <div>
                          <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Expenses you shared (Owe)</div>
                          <ul className="space-y-1.5">
                            {b.details.shared.map((exp, idx) => (
                              <li key={idx} className="flex justify-between text-gray-700 text-xs sm:text-sm">
                                <span className="truncate pr-2">- {exp.description}</span>
                                <span className="whitespace-nowrap font-medium">฿{exp.splitAmount.toFixed(2)}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}

                      {b.details.paid.length > 0 && (
                        <div>
                          <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5 mt-3">Expenses you paid (Get Back)</div>
                          <ul className="space-y-1.5">
                            {b.details.paid.map((exp, idx) => (
                              <li key={idx} className="flex justify-between text-gray-700 text-xs sm:text-sm">
                                <span className="truncate pr-2">+ {exp.description}</span>
                                <span className="whitespace-nowrap font-medium">฿{exp.amount.toFixed(2)}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Add Member Form */}
      <div className="bg-gray-50 p-4 rounded-xl border border-gray-100">
        <h3 className="text-sm font-medium text-gray-900 mb-2.5 flex items-center gap-2">
          <UserPlus className="w-4 h-4 text-gray-700" /> Add Trip Member
        </h3>
        <form onSubmit={handleAddNewMember} className="flex gap-2">
          <input 
            type="text" 
            placeholder="Name..." 
            value={newMemberName}
            onChange={e => setNewMemberName(e.target.value)}
            className="flex-1 px-3 py-2 text-sm bg-white border border-gray-200 rounded-lg focus:outline-none focus:border-gray-400 transition-colors"
          />
          <button 
            type="submit"
            disabled={!newMemberName.trim()}
            className="px-4 py-2 bg-gray-900 hover:bg-gray-800 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50 cursor-pointer shadow-xs"
          >
            Add
          </button>
        </form>
      </div>
    </div>
  );
};

const SyncStatusModal: React.FC<{
  isOpen: boolean;
  onClose: () => void;
  onOpenVercelModal?: () => void;
}> = ({ isOpen, onClose, onOpenVercelModal }) => {
  const context = useContext(AppContext);
  if (!context) return null;
  const { syncStatus, syncLocalDataToCloud, expenses, members, lastSyncedTime } = context;

  const [isSyncingManual, setIsSyncingManual] = useState(false);
  const [syncFeedback, setSyncFeedback] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleManualSync = async () => {
    setIsSyncingManual(true);
    setSyncFeedback(null);
    try {
      const count = await syncLocalDataToCloud();
      setSyncFeedback(`Data အားလုံး (${count} ခု) Cloud ပေါ်သို့ အောင်မြင်စွာ sync လုပ်ပြီးပါပြီ။`);
    } catch {
      setSyncFeedback('Sync လုပ်ရာတွင် အခက်အခဲရှိနေပါသည်။ ကျေးဇူးပြု၍ ခေတ္တစောင့်ပြီး ထပ်မံကြိုးစားပါ။');
    } finally {
      setIsSyncingManual(false);
    }
  };

  const handleDownloadBackup = () => {
    const backupData = {
      exportedAt: new Date().toISOString(),
      trip: "Split Trip Expenses",
      members,
      expenses,
    };
    const blob = new Blob([JSON.stringify(backupData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `split-trip-backup-${new Date().toISOString().split('T')[0]}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-xs">
      <div className="fixed inset-0" onClick={onClose} />

      <div className="relative bg-white rounded-2xl shadow-xl max-w-md w-full p-6 z-10 fade-in border border-gray-100">
        <div className="flex justify-between items-center mb-5 pb-3 border-b border-gray-100">
          <div className="flex items-center gap-2">
            <Cloud className="w-5 h-5 text-gray-800" />
            <h3 className="text-lg font-semibold text-gray-900">Cloud Sync (အချိန်နှင့်တပြေးညီ)</h3>
          </div>
          <button 
            type="button" 
            onClick={onClose} 
            className="p-1.5 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100 transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="space-y-4">
          {/* Status Banner */}
          <div className={`p-4 rounded-xl border flex items-start gap-3 ${
            syncStatus === 'synced'
              ? 'bg-emerald-50/80 border-emerald-200 text-emerald-900'
              : syncStatus === 'syncing'
              ? 'bg-blue-50/80 border-blue-200 text-blue-900'
              : 'bg-amber-50/80 border-amber-200 text-amber-900'
          }`}>
            {syncStatus === 'synced' ? (
              <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" />
            ) : syncStatus === 'syncing' ? (
              <RefreshCw className="w-5 h-5 text-blue-600 shrink-0 mt-0.5 animate-spin" />
            ) : (
              <CloudOff className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
            )}
            <div className="text-sm">
              <p className="font-semibold mb-0.5">
                {syncStatus === 'synced' 
                  ? 'Cloud Synced (အချက်အလက်များ ချိတ်ဆက်ပြီး)' 
                  : syncStatus === 'syncing'
                  ? 'Syncing... (Cloud သို့ တင်နေပါသည်)'
                  : 'Offline (စက်တွင်း၌ သိမ်းဆည်းထားသည်)'}
              </p>
              <p className="text-xs text-gray-600 leading-relaxed">
                {syncStatus === 'synced'
                  ? 'ထည့်သွင်းထားသော စာရင်းများအားလုံး Cloud ပေါ်တွင် လုံခြုံစွာ သိမ်းဆည်းထားပြီး အဖွဲ့ဝင်အားလုံး ဖုန်း/ကွန်ပျူတာတိုင်းတွင် အချိန်နှင့်တပြေးညီ တပြိုင်နက် မြင်တွေ့နိုင်ပါသည်။'
                  : syncStatus === 'syncing'
                  ? 'အသစ်ထည့်သွင်း/ပြင်ဆင်ထားသော အချက်အလက်များကို Cloud ပေါ်သို့ တင်ပို့နေပါသည်...'
                  : 'လက်ရှိ အင်တာနက် အဆင်မပြေပါကလည်း ထည့်သွင်းထားသော data များ မပျက်စီးစေရန် စက်တွင်း (Local Cache) တွင် အပြည့်အဝ မှတ်သားထားပါသည်။'}
              </p>
            </div>
          </div>

          {/* Stats */}
          <div className="grid grid-cols-2 gap-3 text-center">
            <div className="bg-gray-50 p-3 rounded-xl border border-gray-100">
              <span className="text-xs text-gray-500 block">စုစုပေါင်း စာရင်း</span>
              <span className="text-xl font-semibold text-gray-900">{expenses.length} ခု</span>
            </div>
            <div className="bg-gray-50 p-3 rounded-xl border border-gray-100">
              <span className="text-xs text-gray-500 block">အဖွဲ့ဝင် စုစုပေါင်း</span>
              <span className="text-xl font-semibold text-gray-900">{members.length} ဦး</span>
            </div>
          </div>

          {lastSyncedTime && (
            <p className="text-center text-xs text-gray-400">
              နောက်ဆုံး ချိတ်ဆက်ချိန်: {lastSyncedTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            </p>
          )}

          {syncFeedback && (
            <div className="p-3 bg-gray-50 rounded-lg text-xs text-gray-800 border border-gray-200">
              {syncFeedback}
            </div>
          )}

          {/* Action Buttons */}
          <div className="space-y-2 pt-2">
            <button 
              type="button" 
              onClick={handleManualSync}
              disabled={isSyncingManual}
              className="w-full bg-gray-900 hover:bg-gray-800 text-white font-medium py-2.5 rounded-xl transition-colors flex items-center justify-center gap-2 cursor-pointer text-sm shadow-xs disabled:opacity-50"
            >
              <RefreshCw className={`w-4 h-4 ${isSyncingManual ? 'animate-spin' : ''}`} />
              <span>စက်တွင်း Data များကို Cloud သို့ ပြန်လည် Sync လုပ်ရန်</span>
            </button>

            {onOpenVercelModal && (
              <button 
                type="button" 
                onClick={() => {
                  onClose();
                  onOpenVercelModal();
                }}
                className="w-full bg-amber-50 hover:bg-amber-100 text-amber-900 border border-amber-200 font-medium py-2.5 rounded-xl transition-colors flex items-center justify-center gap-2 cursor-pointer text-sm"
              >
                <ArrowRightLeft className="w-4 h-4 text-amber-700" />
                <span>trip-alpha-nine.vercel.app မှ Data ပြောင်းရွှေ့ရန်</span>
              </button>
            )}

            <button 
              type="button" 
              onClick={handleDownloadBackup}
              className="w-full bg-gray-100 hover:bg-gray-200 text-gray-700 font-medium py-2.5 rounded-xl transition-colors flex items-center justify-center gap-2 cursor-pointer text-sm"
            >
              <Download className="w-4 h-4 text-gray-600" />
              <span>Backup ဒေါင်းလုဒ်ရယူရန် (.JSON ဖိုင်)</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

const VercelMigrationModal: React.FC<{
  isOpen: boolean;
  onClose: () => void;
}> = ({ isOpen, onClose }) => {
  const context = useContext(AppContext);
  if (!context) return null;
  const { importData } = context;

  const [activeTab, setActiveTab] = useState<'script' | 'paste'>('script');
  const [copied, setCopied] = useState(false);
  const [pasteContent, setPasteContent] = useState('');
  const [isImporting, setIsImporting] = useState(false);
  const [statusMessage, setStatusMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  if (!isOpen) return null;

  const currentAppUrl = window.location.origin + window.location.pathname;

  const migrationScript = `location.href='${currentAppUrl}?import_data='+encodeURIComponent(JSON.stringify({expenses:JSON.parse(localStorage.getItem('trip-expenses-v2')||'[]'),members:JSON.parse(localStorage.getItem('trip-members-v1')||'[]')}))`;

  const handleCopyScript = () => {
    navigator.clipboard.writeText(migrationScript);
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  };

  const handlePasteImport = async () => {
    if (!pasteContent.trim()) {
      setStatusMessage({ type: 'error', text: 'ကျေးဇူးပြု၍ JSON data သို့မဟုတ် စာရင်းကို ထည့်သွင်းပေးပါ။' });
      return;
    }
    setIsImporting(true);
    setStatusMessage(null);
    try {
      const result = await importData(pasteContent);
      setStatusMessage({
        type: 'success',
        text: `အောင်မြင်ပါသည်! စာရင်း (${result.expensesCount}) ခု နှင့် အဖွဲ့ဝင် (${result.membersCount}) ဦး ကို Cloud ပေါ်သို့ တင်သွင်းပြီးပါပြီ။`,
      });
      setTimeout(() => {
        onClose();
      }, 2000);
    } catch (err: any) {
      setStatusMessage({
        type: 'error',
        text: err?.message || 'Data တင်သွင်းရာတွင် အဆင်မပြေဖြစ်သွားပါသည်။ JSON format ကို ပြန်လည်စစ်ဆေးပေးပါ။',
      });
    } finally {
      setIsImporting(false);
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (event) => {
        const text = event.target?.result as string;
        if (text) {
          setPasteContent(text);
          setActiveTab('paste');
        }
      };
      reader.readAsText(file);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-xs">
      <div className="fixed inset-0" onClick={onClose} />

      <div className="relative bg-white rounded-2xl shadow-xl max-w-lg w-full max-h-[90vh] overflow-y-auto z-10 p-6 fade-in border border-gray-100">
        <div className="flex justify-between items-center mb-4 pb-3 border-b border-gray-100">
          <div className="flex items-center gap-2">
            <ArrowRightLeft className="w-5 h-5 text-indigo-600" />
            <div>
              <h3 className="text-lg font-semibold text-gray-900">Vercel မှ Data ပြောင်းရွှေ့ရန်</h3>
              <p className="text-xs text-gray-500">trip-alpha-nine.vercel.app ရှိ data များကို Cloud သို့ ရယူခြင်း</p>
            </div>
          </div>
          <button 
            type="button" 
            onClick={onClose} 
            className="p-1.5 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100 transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Info callout */}
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-3.5 mb-5 text-xs text-amber-900 leading-relaxed">
          <p className="font-semibold mb-1 flex items-center gap-1.5">
            <Sparkles className="w-4 h-4 text-amber-600 shrink-0" />
            Vercel တွင် ဖြည့်ထားသော စာရင်းများ ပျောက်မသွားပါ
          </p>
          <p>
            သင်တို့ ဖြည့်ထားသော စာရင်းများသည် <code className="bg-amber-100 px-1 py-0.5 rounded font-mono">trip-alpha-nine.vercel.app</code> ၏ Browser Local Storage ထဲတွင် သိမ်းထားဆဲဖြစ်ပါသည်။ ၎င်းတို့ကို ဤ Firebase Cloud စနစ်သစ်ထဲသို့ အောက်ပါနည်းလမ်း ၂ မျိုးအနက် အဆင်ပြေရာဖြင့် ချက်ချင်း ပြောင်းရွှေ့နိုင်ပါသည်:
          </p>
        </div>

        {/* Tab switcher */}
        <div className="flex rounded-lg bg-gray-100 p-1 mb-5">
          <button
            type="button"
            onClick={() => setActiveTab('script')}
            className={`flex-1 py-2 text-xs font-medium rounded-md transition-all cursor-pointer ${
              activeTab === 'script' ? 'bg-white text-gray-900 shadow-xs' : 'text-gray-500 hover:text-gray-900'
            }`}
          >
            နည်းလမ်း ၁ - 1-Click Script (အလွယ်ဆုံး)
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('paste')}
            className={`flex-1 py-2 text-xs font-medium rounded-md transition-all cursor-pointer ${
              activeTab === 'paste' ? 'bg-white text-gray-900 shadow-xs' : 'text-gray-500 hover:text-gray-900'
            }`}
          >
            နည်းလမ်း ၂ - Data တိုက်ရိုက် Paste ရန်
          </button>
        </div>

        {activeTab === 'script' ? (
          <div className="space-y-4">
            <div className="space-y-3 text-xs text-gray-600">
              <div className="flex items-start gap-2.5">
                <span className="w-5 h-5 rounded-full bg-gray-900 text-white flex items-center justify-center font-bold shrink-0 text-[10px]">1</span>
                <div>
                  <p className="font-medium text-gray-800">အောက်ပါ ကူးယူခလုတ် (Copy Script) ကို နှိပ်ပါ:</p>
                </div>
              </div>

              <div className="relative">
                <textarea
                  readOnly
                  value={migrationScript}
                  rows={3}
                  className="w-full bg-gray-900 text-gray-100 p-3 rounded-xl font-mono text-[11px] leading-tight select-all focus:outline-none"
                />
                <button
                  type="button"
                  onClick={handleCopyScript}
                  className="absolute right-2 top-2 bg-white/10 hover:bg-white/20 text-white px-2.5 py-1 rounded-lg text-xs font-medium flex items-center gap-1.5 transition-colors cursor-pointer"
                >
                  {copied ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-emerald-400" />
                      <span className="text-emerald-400">Copied!</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5" />
                      <span>Copy Script</span>
                    </>
                  )}
                </button>
              </div>

              <div className="flex items-start gap-2.5 pt-1">
                <span className="w-5 h-5 rounded-full bg-gray-900 text-white flex items-center justify-center font-bold shrink-0 text-[10px]">2</span>
                <div>
                  <p className="font-medium text-gray-800">
                    <a 
                      href="https://trip-alpha-nine.vercel.app/" 
                      target="_blank" 
                      rel="noopener noreferrer"
                      className="text-indigo-600 hover:underline font-semibold inline-flex items-center gap-1"
                    >
                      trip-alpha-nine.vercel.app <ExternalLink className="w-3 h-3" />
                    </a> ဖွင့်ထားသော tab သို့ သွားပါ။
                  </p>
                </div>
              </div>

              <div className="flex items-start gap-2.5">
                <span className="w-5 h-5 rounded-full bg-gray-900 text-white flex items-center justify-center font-bold shrink-0 text-[10px]">3</span>
                <div>
                  <p className="font-medium text-gray-800">
                    Browser Console (F12 သို့မဟုတ် Inspect &gt; Console) တွင် Paste ချပြီး <kbd className="bg-gray-200 px-1 py-0.5 rounded text-[10px] font-mono">Enter</kbd> နှိပ်လိုက်ပါ။
                  </p>
                  <p className="text-[11px] text-gray-500 mt-0.5">
                    (ဖုန်းတွင်ဖြစ်ပါက Address bar တွင် <code className="bg-gray-100 px-1 rounded font-mono">javascript:</code> ဟု ရိုက်ထည့်၍ အနောက်တွင် paste ချပြီး သွားနိုင်ပါသည်)
                  </p>
                </div>
              </div>

              <div className="flex items-start gap-2.5">
                <span className="w-5 h-5 rounded-full bg-emerald-600 text-white flex items-center justify-center font-bold shrink-0 text-[10px]">✓</span>
                <div>
                  <p className="font-medium text-emerald-700">
                    Vercel ရှိ စာရင်းအားလုံး ဤနေရာသို့ အလိုအလျောက် ပြောင်းရွှေ့ရောက်ရှိလာပြီး Cloud Database တွင် အဖွဲ့ဝင်အားလုံးအတွက် သိမ်းဆည်းသွားပါမည်!
                  </p>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-xs text-gray-600">
              <code className="bg-gray-100 px-1 py-0.5 rounded font-mono">trip-alpha-nine.vercel.app</code> ၏ Console တွင် <code className="bg-gray-100 px-1 py-0.5 rounded font-mono">copy(localStorage.getItem('trip-expenses-v2'))</code> ဟု ရိုက်၍ ရရှိလာသော စာရင်း JSON သို့မဟုတ် Backup JSON ကို အောက်တွင် paste ချပါ:
            </p>

            <textarea
              value={pasteContent}
              onChange={(e) => setPasteContent(e.target.value)}
              placeholder='[{"id":"...","description":"Dinner","amount":1500,"paidBy":"Shan","splitAmong":["Shan",...]}]'
              rows={5}
              className="w-full bg-gray-50 border border-gray-200 rounded-xl p-3 text-xs font-mono focus:outline-none focus:border-gray-400 focus:bg-white transition-colors"
            />

            <div className="flex items-center justify-between">
              <label className="text-xs text-gray-500 hover:text-gray-700 cursor-pointer flex items-center gap-1.5">
                <Upload className="w-3.5 h-3.5" />
                <span>JSON ဖိုင် ရွေးချယ်ရန်</span>
                <input 
                  type="file" 
                  accept=".json" 
                  onChange={handleFileUpload} 
                  className="hidden" 
                />
              </label>

              <button
                type="button"
                onClick={handlePasteImport}
                disabled={isImporting || !pasteContent.trim()}
                className="bg-gray-900 hover:bg-gray-800 text-white text-xs font-medium px-4 py-2 rounded-xl transition-colors disabled:opacity-50 flex items-center gap-2 cursor-pointer shadow-xs"
              >
                {isImporting ? (
                  <>
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    <span>Importing...</span>
                  </>
                ) : (
                  <>
                    <Sparkles className="w-3.5 h-3.5" />
                    <span>ယခု တင်သွင်းမည် (Import Now)</span>
                  </>
                )}
              </button>
            </div>

            {statusMessage && (
              <div className={`p-3 rounded-xl text-xs flex items-center gap-2 ${
                statusMessage.type === 'success' 
                  ? 'bg-emerald-50 text-emerald-800 border border-emerald-200' 
                  : 'bg-red-50 text-red-800 border border-red-200'
              }`}>
                {statusMessage.type === 'success' ? (
                  <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                ) : (
                  <AlertCircle className="w-4 h-4 text-red-600 shrink-0" />
                )}
                <span>{statusMessage.text}</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

const MainApp: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'add' | 'list' | 'balances'>('add');
  const [showSyncModal, setShowSyncModal] = useState(false);
  const [showVercelModal, setShowVercelModal] = useState(false);
  const context = useContext(AppContext);
  const syncStatus = context?.syncStatus || 'synced';
  const importSuccessMessage = context?.importSuccessMessage;
  const clearImportSuccessMessage = context?.clearImportSuccessMessage;

  return (
    <div className="min-h-screen bg-white font-sans text-gray-900 pb-20 md:pb-8 selection:bg-gray-200">
      {/* Import Notification Banner */}
      {importSuccessMessage && (
        <div className="bg-emerald-50 border-b border-emerald-200 px-4 py-2.5 flex items-center justify-between text-xs text-emerald-900 fade-in sticky top-0 z-50">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
            <span className="font-medium">{importSuccessMessage}</span>
          </div>
          <button 
            onClick={clearImportSuccessMessage}
            className="text-emerald-700 hover:text-emerald-900 p-1 cursor-pointer"
            title="Dismiss"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Header */}
      <header className="border-b border-gray-100 sticky top-0 bg-white/90 backdrop-blur-md z-40">
        <div className="max-w-4xl mx-auto px-4 md:px-6 h-14 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-semibold tracking-tight text-gray-900">Split</h1>
            <span className="text-[11px] font-medium text-gray-500 bg-gray-100 px-2 py-0.5 rounded-full">Trip</span>
            
            {/* Real-time Cloud Sync Badge */}
            <button 
              onClick={() => setShowSyncModal(true)}
              className={`flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium transition-all cursor-pointer ${
                syncStatus === 'synced'
                  ? 'bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100'
                  : syncStatus === 'syncing'
                  ? 'bg-blue-50 text-blue-700 border border-blue-200'
                  : 'bg-amber-50 text-amber-700 border border-amber-200 hover:bg-amber-100'
              }`}
              title="Cloud Sync Status & Backup"
            >
              {syncStatus === 'synced' && (
                <>
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
                  <Cloud className="w-3.5 h-3.5 text-emerald-600" />
                  <span className="text-[11px] hidden xs:inline">Synced</span>
                </>
              )}
              {syncStatus === 'syncing' && (
                <>
                  <RefreshCw className="w-3.5 h-3.5 text-blue-600 animate-spin" />
                  <span className="text-[11px] hidden xs:inline">Syncing...</span>
                </>
              )}
              {syncStatus === 'offline' && (
                <>
                  <CloudOff className="w-3.5 h-3.5 text-amber-600" />
                  <span className="text-[11px] hidden xs:inline">Local</span>
                </>
              )}
            </button>

            {/* Import from Vercel button */}
            <button
              onClick={() => setShowVercelModal(true)}
              className="flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium bg-amber-50 hover:bg-amber-100 text-amber-800 border border-amber-200 transition-colors cursor-pointer"
              title="Import data from trip-alpha-nine.vercel.app"
            >
              <ArrowRightLeft className="w-3 h-3 text-amber-700" />
              <span className="text-[11px] hidden sm:inline">Import Vercel</span>
            </button>
          </div>
          
          {/* Desktop Navigation */}
          <div className="hidden md:flex space-x-6 text-sm">
            <button 
              onClick={() => setActiveTab('add')} 
              className={`transition-colors py-4 border-b-2 cursor-pointer ${
                activeTab === 'add' ? 'border-gray-900 text-gray-900 font-medium' : 'border-transparent text-gray-500 hover:text-gray-900'
              }`}
            >
              Add
            </button>
            <button 
              onClick={() => setActiveTab('list')} 
              className={`transition-colors py-4 border-b-2 cursor-pointer ${
                activeTab === 'list' ? 'border-gray-900 text-gray-900 font-medium' : 'border-transparent text-gray-500 hover:text-gray-900'
              }`}
            >
              History
            </button>
            <button 
              onClick={() => setActiveTab('balances')} 
              className={`transition-colors py-4 border-b-2 cursor-pointer ${
                activeTab === 'balances' ? 'border-gray-900 text-gray-900 font-medium' : 'border-transparent text-gray-500 hover:text-gray-900'
              }`}
            >
              Settle
            </button>
          </div>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="max-w-4xl mx-auto p-4 md:p-8 md:mt-4">
        {activeTab === 'add' && <AddExpenseForm onSave={() => setActiveTab('list')} />}
        {activeTab === 'list' && <ExpenseList onOpenVercelModal={() => setShowVercelModal(true)} />}
        {activeTab === 'balances' && <BalancesDashboard />}
      </main>

      {/* Mobile Bottom Navigation */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 bg-white border-t border-gray-100 z-50 px-2 pb-safe shadow-lg">
        <div className="flex justify-around items-center h-16">
          <button 
            onClick={() => setActiveTab('add')}
            className={`flex flex-col items-center justify-center flex-1 h-full px-2 transition-colors cursor-pointer ${
              activeTab === 'add' ? 'text-gray-900' : 'text-gray-400'
            }`}
          >
            <Plus className="w-5 h-5 mb-1" strokeWidth={activeTab === 'add' ? 2.5 : 2} />
            <span className="text-[11px] font-medium">Add</span>
          </button>
          
          <button 
            onClick={() => setActiveTab('list')}
            className={`flex flex-col items-center justify-center flex-1 h-full px-2 transition-colors cursor-pointer ${
              activeTab === 'list' ? 'text-gray-900' : 'text-gray-400'
            }`}
          >
            <List className="w-5 h-5 mb-1" strokeWidth={activeTab === 'list' ? 2.5 : 2} />
            <span className="text-[11px] font-medium">History</span>
          </button>
          
          <button 
            onClick={() => setActiveTab('balances')}
            className={`flex flex-col items-center justify-center flex-1 h-full px-2 transition-colors cursor-pointer ${
              activeTab === 'balances' ? 'text-gray-900' : 'text-gray-400'
            }`}
          >
            <Calculator className="w-5 h-5 mb-1" strokeWidth={activeTab === 'balances' ? 2.5 : 2} />
            <span className="text-[11px] font-medium">Settle</span>
          </button>
        </div>
      </nav>

      {/* Cloud Sync Details Modal */}
      <SyncStatusModal 
        isOpen={showSyncModal} 
        onClose={() => setShowSyncModal(false)}
        onOpenVercelModal={() => setShowVercelModal(true)}
      />

      {/* Vercel Migration Modal */}
      <VercelMigrationModal
        isOpen={showVercelModal}
        onClose={() => setShowVercelModal(false)}
      />
    </div>
  );
};

export default function App() {
  return (
    <AppProvider>
      <MainApp />
    </AppProvider>
  );
}
