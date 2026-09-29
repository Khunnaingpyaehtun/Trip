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
  Trash2
} from 'lucide-react';

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

export interface Settlement {
  from: string;
  to: string;
  amount: number;
}

interface AppContextType {
  expenses: Expense[];
  addExpense: (expense: Expense) => void;
  updateExpense: (expense: Expense) => void;
  deleteExpense: (id: string) => void;
  members: string[];
  addMember: (name: string) => void;
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

  const addExpense = (expense: Expense) => {
    setExpenses(prev => [expense, ...prev]);
  };

  const updateExpense = (expense: Expense) => {
    setExpenses(prev => prev.map(e => e.id === expense.id ? expense : e));
  };

  const deleteExpense = (id: string) => {
    setExpenses(prev => prev.filter(e => e.id !== id));
  };

  const addMember = (name: string) => {
    const trimmed = name.trim();
    if (trimmed && !members.includes(trimmed)) {
      setMembers(prev => [...prev, trimmed]);
    }
  };

  return (
    <AppContext.Provider value={{ expenses, addExpense, updateExpense, deleteExpense, members, addMember }}>
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

const ExpenseList: React.FC = () => {
  const context = useContext(AppContext);
  if (!context) throw new Error("ExpenseList must be used within AppProvider");
  const { expenses, updateExpense, deleteExpense, members, addMember } = context;

  const [deletePendingId, setDeletePendingId] = useState<string | null>(null);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [editingExpense, setEditingExpense] = useState<Expense | null>(null);

  if (expenses.length === 0) {
    return (
      <div className="text-center py-20 text-gray-500 fade-in">
        <List className="w-8 h-8 mx-auto mb-3 text-gray-300" />
        <p>No expenses yet.</p>
        <p className="text-xs text-gray-400 mt-1">Add your first expense to begin tracking.</p>
      </div>
    );
  }

  return (
    <div className="max-w-lg mx-auto fade-in">
      <div className="flex justify-between items-center mb-6">
        <h2 className="text-xl font-medium text-gray-900">History</h2>
        <span className="text-xs text-gray-500 font-medium bg-gray-100 px-2.5 py-1 rounded-full">
          {expenses.length} {expenses.length === 1 ? 'item' : 'items'}
        </span>
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

const MainApp: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'add' | 'list' | 'balances'>('add');

  return (
    <div className="min-h-screen bg-white font-sans text-gray-900 pb-20 md:pb-8 selection:bg-gray-200">
      {/* Header */}
      <header className="border-b border-gray-100 sticky top-0 bg-white/90 backdrop-blur-md z-40">
        <div className="max-w-4xl mx-auto px-4 md:px-6 h-14 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-semibold tracking-tight text-gray-900">Split</h1>
            <span className="text-[11px] font-medium text-gray-500 bg-gray-100 px-2 py-0.5 rounded-full">Trip</span>
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
        {activeTab === 'list' && <ExpenseList />}
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
