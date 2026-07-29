import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowLeft, User, LogOut, Edit3, Save, X, Mail, Info, Lock, KeyRound, AlertCircle, CheckCircle2 } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { Helmet } from 'react-helmet-async';
import { clearAuthSession, getAuthUser } from './authStorage';

const API_URL = process.env.REACT_APP_BACKEND_URL ;


const Profile = () => {
    const navigate = useNavigate();
    const [isScrolled, setIsScrolled] = useState(false);
    const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
    
    // Load user from storage
    const initialUser = getAuthUser() || {};
    const [userData, setUserData] = useState({
        // Keep the complete authenticated user object here. In particular,
        // batchId/batch must survive profile updates or ProtectedRoute will
        // treat the student as someone who has not selected a batch.
        ...initialUser,
        name: initialUser.name || 'Anonymous User',
        email: initialUser.email || 'guest@zest.com',
        role: initialUser.role || 'Student',
        profilePic: initialUser.dp || initialUser.profilePic || null
    });

    const [isEditing, setIsEditing] = useState(false);
    const [tempData, setTempData] = useState({ ...userData });
    const [isSaving, setIsSaving] = useState(false);

    // Modal State
    const [modal, setModal] = useState({
        isOpen: false,
        type: null, // 'email' or 'password'
        step: 0, // 0: sending/intro, 1: OTP, 2: set new value, 3: success
        otp: '',
        newValue: '',
        confirmValue: '',
        loading: false,
        error: ''
    });

    const resetModal = () => setModal({
        isOpen: false, type: null, step: 0, otp: '', newValue: '', confirmValue: '', loading: false, error: ''
    });

    const changePasswordRules = {
        length: modal.newValue.length >= 8 && modal.newValue.length <= 25,
        hasLetter: /[a-zA-Z]/.test(modal.newValue),
        hasNumber: /[0-9]/.test(modal.newValue),
        match: modal.newValue === modal.confirmValue && modal.newValue !== ''
    };

    const isPassValid = changePasswordRules.length && changePasswordRules.hasLetter && changePasswordRules.hasNumber;


    useEffect(() => {
        const handleScroll = () => setIsScrolled(window.scrollY > 20);
        window.addEventListener('scroll', handleScroll);
        return () => window.removeEventListener('scroll', handleScroll);
    }, []);

    const handleLogout = () => {
        clearAuthSession();
        navigate('/auth');
    };

    const handleEditToggle = () => {
        if (isEditing) {
            setTempData({ ...userData });
        }
        setIsEditing(!isEditing);
    };

    const handleChange = (e) => {
        setTempData({ ...tempData, [e.target.name]: e.target.value });
    };

    const handleSave = async () => {
        setIsSaving(true);
        // Simulate API delay
        await new Promise(resolve => setTimeout(resolve, 800));
        
        const updatedUser = { ...userData, ...tempData };
        setUserData(updatedUser);
        
        // Update storage
        const storageType = localStorage.getItem('user') ? localStorage : sessionStorage;
        storageType.setItem('user', JSON.stringify(updatedUser));
        
        setIsEditing(false);
        setIsSaving(false);
    };

    // --- OTP Handlers ---

    const handleInitiateChange = async (type) => {
        setModal(prev => ({ ...prev, isOpen: true, type, step: 0, loading: true, error: '' }));
        try {
            const response = await fetch(`${API_URL}/api/auth/send-otp`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: userData.email })
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.message);
            setModal(prev => ({ ...prev, step: 1, loading: false }));
        } catch (err) {
            setModal(prev => ({ ...prev, error: err.message, loading: false }));
        }
    };

    const handleVerifyOtp = async () => {
        setModal(prev => ({ ...prev, loading: true, error: '' }));
        try {
            const response = await fetch(`${API_URL}/api/auth/verify-otp`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: userData.email, otp: modal.otp })
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.message);
            setModal(prev => ({ ...prev, step: 2, loading: false }));
        } catch (err) {
            setModal(prev => ({ ...prev, error: err.message, loading: false }));
        }
    };

    const handleSubmitChange = async () => {
        if (modal.type === 'password') {
            if (!changePasswordRules.match) {
                return setModal(prev => ({ ...prev, error: 'Passwords do not match' }));
            }
            if (!isPassValid) {
                return setModal(prev => ({ ...prev, error: 'Password does not meet the requirements' }));
            }
        }
        if (modal.type === 'email' && !modal.newValue.match(/^[a-zA-Z0-9._%+-]+@gmail\.com$/)) {
            return setModal(prev => ({ ...prev, error: 'Must be a valid Gmail address' }));
        }

        setModal(prev => ({ ...prev, loading: true, error: '' }));
        try {
            const endpoint = modal.type === 'email' ? '/api/auth/change-email' : '/api/auth/change-password';
            const payload = modal.type === 'email' 
                ? { currentEmail: userData.email, newEmail: modal.newValue, otp: modal.otp }
                : { email: userData.email, newPassword: modal.newValue, otp: modal.otp };

            const response = await fetch(`${API_URL}${endpoint}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.message);

            if (modal.type === 'email' && data.user) {
                const updatedUser = { ...userData, ...data.user, email: data.user.email };
                setUserData(updatedUser);
                const storageType = localStorage.getItem('user') ? localStorage : sessionStorage;
                storageType.setItem('user', JSON.stringify(updatedUser));
            }

            setModal(prev => ({ ...prev, step: 3, loading: false }));
            setTimeout(resetModal, 2000); // Auto close after success
        } catch (err) {
            setModal(prev => ({ ...prev, error: err.message, loading: false }));
        }
    };


    return (
        <div className="min-h-screen bg-[#fffef2] text-navy font-sans selection:bg-lime/30 flex flex-col overflow-x-hidden">
            <Helmet>
                <title>Zest - Profile</title>
            </Helmet>

            {/* Navigation (Standardized) */}
            <nav className={`fixed w-full z-50 transition-all duration-300 backdrop-blur-md border-b border-white/20 ${isScrolled
                ? 'bg-[#92c211] md:bg-[#92c211]/60 py-1'
                : 'bg-[#92c211] md:bg-[#92c211]/90 py-0'
                }`}>
                <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
                    <div className="flex items-center justify-between h-16">
                        <div className="flex items-center gap-3">
                            <Link to="/home" className="flex items-center gap-2 text-white hover:opacity-80 transition-opacity">
                                <ArrowLeft size={20} />
                            </Link>
                            <img src="/logo.png" alt="Zest Logo" className="w-8 h-8 object-contain" />
                            <span className="text-white font-bold text-xl tracking-tight">Zest</span>
                        </div>

                        <div className="flex items-center gap-3">
                            <div className="hidden md:flex items-center gap-8 mr-4">
                                <Link to="/profile" className="text-white nav-hover-underline underline-offset-8 decoration-2 px-1 py-2 text-lg tracking-tight transition-all">Profile</Link>
                                <Link to="/analytics" className="text-white nav-hover-draw px-1 py-2 text-lg tracking-tight transition-all">Analytics</Link>
                            </div>
                            <button onClick={handleLogout} className="hidden md:flex items-center gap-2 px-4 py-2 bg-white/10 hover:bg-white/20 text-white rounded-xl transition-colors font-bold">
                                <LogOut size={18} />
                                <span>Logout</span>
                            </button>
                            <button onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)} className="md:hidden p-2 text-white">
                                <div className="w-6 h-5 flex flex-col justify-between">
                                    <span className={`h-1 w-full bg-white rounded-full transition-all ${isMobileMenuOpen ? 'rotate-45 translate-y-2' : ''}`}></span>
                                    <span className={`h-1 w-full bg-white rounded-full transition-all ${isMobileMenuOpen ? 'opacity-0' : ''}`}></span>
                                    <span className={`h-1 w-full bg-white rounded-full transition-all ${isMobileMenuOpen ? '-rotate-45 -translate-y-2' : ''}`}></span>
                                </div>
                            </button>
                        </div>
                    </div>
                </div>
                <div className={`md:hidden bg-lime transition-all duration-300 overflow-hidden ${isMobileMenuOpen ? 'max-h-64 border-b border-white/20' : 'max-h-0'}`}>
                    <div className="px-4 py-6 space-y-4">
                        <Link to="/profile" className="block text-white font-bold text-lg" onClick={() => setIsMobileMenuOpen(false)}>Profile</Link>
                        <Link to="/analytics" className="block text-white font-bold text-lg" onClick={() => setIsMobileMenuOpen(false)}>Analytics</Link>
                        <button onClick={handleLogout} className="flex items-center gap-2 text-white font-bold text-lg pt-4 border-t border-white/20 w-full">
                            <LogOut size={20} /> Logout
                        </button>
                    </div>
                </div>
            </nav>

            <main className="flex-1 pt-32 pb-20 px-4">
                <div className="max-w-4xl mx-auto">
                    {/* Hero Profile Section */}
                    <motion.div 
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        className="bg-white rounded-[2.5rem] border border-slate-200 shadow-xl shadow-navy/5 p-8 md:p-12 mb-8 relative overflow-hidden"
                    >
                        <div className="absolute top-0 left-0 w-full h-32 bg-gradient-to-r from-lime/20 to-lime/10"></div>
                        
                        <div className="relative flex flex-col md:flex-row items-center md:items-end gap-8 mt-4">
                            <div className="relative">
                                <div className="w-32 h-32 md:w-40 md:h-40 bg-slate-100 rounded-[2rem] flex items-center justify-center text-slate-400 border-4 border-white shadow-xl overflow-hidden">
                                    {userData.profilePic ? (
                                        <img src={userData.profilePic} alt="Profile" referrerPolicy="no-referrer" className="w-full h-full object-cover" />
                                    ) : (
                                        <User size={64} />
                                    )}
                                </div>
                            </div>

                            <div className="flex-1 text-center md:text-left">
                                <div className="flex flex-col md:flex-row md:items-center gap-4 mb-2">
                                    <h1 className="text-4xl font-extrabold text-navy tracking-tight">{userData.name}</h1>
                                    <span className="inline-block px-4 py-1 bg-lime/10 text-navy text-xs font-black uppercase tracking-widest rounded-full">{userData.role}</span>
                                </div>
                                <p className="text-slate-500 font-medium text-lg leading-relaxed flex items-center justify-center md:justify-start gap-2">
                                    <Mail size={18} className="text-lime" /> {userData.email}
                                </p>
                            </div>

                            <button 
                                onClick={handleEditToggle}
                                className={`flex items-center gap-2 px-6 py-3 rounded-2xl font-bold transition-all ${
                                    isEditing ? 'bg-slate-100 text-slate-500 hover:bg-slate-200' : 'bg-navy text-white shadow-lg shadow-navy/20 hover:scale-105'
                                }`}
                            >
                                {isEditing ? <><X size={18}/> Cancel</> : <><Edit3 size={18}/> Edit Profile</>}
                            </button>
                        </div>
                    </motion.div>

                    {/* Details Grid */}
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
                        {/* Status/Banner side */}
                        <div className="md:col-span-1 space-y-6">
                            <motion.div 
                                initial={{ opacity: 0, x: -20 }}
                                animate={{ opacity: 1, x: 0 }}
                                transition={{ delay: 0.1 }}
                                className="bg-navy text-white p-8 rounded-[2rem] shadow-xl shadow-navy/20"
                            >
                                <div className="flex items-center gap-3 mb-6">
                                    <Info size={24} className="text-lime" />
                                    <h3 className="text-xl font-bold">Zest Member</h3>
                                </div>
                                <p className="text-white/70 text-sm font-medium leading-relaxed mb-6">
                                    Joined the platform to master Data Structures & Algorithms. All rights reserved.
                                </p>
                                <div className="flex items-center gap-3 text-lime font-black text-sm uppercase tracking-widest">
                                    <span>Verfied</span>
                                    <div className="w-2 h-2 rounded-full bg-lime animate-pulse"></div>
                                </div>
                            </motion.div>

                            <motion.div 
                                initial={{ opacity: 0, x: -20 }}
                                animate={{ opacity: 1, x: 0 }}
                                transition={{ delay: 0.2 }}
                                className="bg-white p-6 rounded-[2rem] border border-slate-200 shadow-sm"
                            >
                                <h3 className="text-xs font-black uppercase tracking-wider text-slate-400 mb-4">Security Settings</h3>
                                {isEditing ? (
                                    <div className="space-y-3">
                                        <button onClick={() => handleInitiateChange('email')} className="w-full flex items-center justify-between p-4 bg-slate-50 hover:bg-slate-100 border border-slate-100 rounded-xl transition-all group">
                                            <div className="flex items-center gap-3">
                                                <div className="p-2 bg-navy/5 text-navy rounded-lg group-hover:bg-navy group-hover:text-white transition-colors"><Mail size={16} /></div>
                                                <span className="font-bold text-navy text-sm">Change Email ID</span>
                                            </div>
                                            <ArrowLeft size={16} className="rotate-180 text-slate-300 group-hover:text-navy transition-colors" />
                                        </button>
                                        <button onClick={() => handleInitiateChange('password')} className="w-full flex items-center justify-between p-4 bg-slate-50 hover:bg-slate-100 border border-slate-100 rounded-xl transition-all group">
                                            <div className="flex items-center gap-3">
                                                <div className="p-2 bg-navy/5 text-navy rounded-lg group-hover:bg-navy group-hover:text-white transition-colors"><KeyRound size={16} /></div>
                                                <span className="font-bold text-navy text-sm">Change Password</span>
                                            </div>
                                            <ArrowLeft size={16} className="rotate-180 text-slate-300 group-hover:text-navy transition-colors" />
                                        </button>
                                    </div>
                                ) : (
                                    <div className="text-xs text-slate-500 font-medium leading-relaxed bg-slate-50 p-4 rounded-xl border border-slate-100">
                                        Click on <span className="text-navy font-bold">Edit Profile</span> to update your Email ID or Password securely via OTP verification.
                                    </div>
                                )}
                            </motion.div>
                        </div>

                        {/* Editable Form Side */}
                        <motion.div 
                            initial={{ opacity: 0, x: 20 }}
                            animate={{ opacity: 1, x: 0 }}
                            transition={{ delay: 0.1 }}
                            className="md:col-span-2 bg-white rounded-[2.5rem] border border-slate-200 shadow-xl shadow-navy/5 p-8 md:p-10"
                        >
                            <div className="flex items-center justify-between mb-8">
                                <h2 className="text-2xl font-bold text-navy flex items-center gap-3">
                                    {isEditing ? 'Update your details' : 'Personal Information'}
                                </h2>
                                {isEditing && (
                                    <button 
                                        onClick={handleSave}
                                        disabled={isSaving}
                                        className="flex items-center gap-2 px-6 py-3 bg-lime text-navy font-black uppercase tracking-widest text-xs rounded-2xl shadow-lg shadow-lime/20 hover:scale-105 transition-all disabled:opacity-50"
                                    >
                                        {isSaving ? <div className="w-4 h-4 border-2 border-navy/30 border-t-navy rounded-full animate-spin"></div> : <Save size={16} />}
                                        Save Changes
                                    </button>
                                )}
                            </div>

                            <form className="space-y-6">
                                {/* Name Input */}
                                <div className="space-y-2">
                                    <label className="text-xs font-black uppercase tracking-widest text-slate-400 ml-1">Full Name</label>
                                    <div className="relative">
                                        <User className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
                                        <input 
                                            type="text" 
                                            name="name"
                                            value={isEditing ? tempData.name : userData.name}
                                            onChange={handleChange}
                                            disabled={!isEditing}
                                            className="w-full pl-12 pr-4 py-4 bg-slate-50 border-2 border-transparent focus:border-lime focus:bg-white rounded-2xl outline-none transition-all font-bold disabled:text-slate-500 disabled:bg-slate-50/50"
                                            placeholder="Your Name"
                                        />
                                    </div>
                                </div>

                                {/* Email Input (READ ONLY) */}
                                <div className="space-y-2">
                                    <div className="flex justify-between px-1">
                                        <label className="text-xs font-black uppercase tracking-widest text-slate-400">Email ID</label>
                                        <span className="text-[10px] font-bold text-slate-400 flex items-center gap-1 uppercase tracking-tighter italic">🔒 Read Only</span>
                                    </div>
                                    <div className="relative">
                                        <Mail className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-300" size={18} />
                                        <input 
                                            type="email" 
                                            value={userData.email}
                                            disabled
                                            className="w-full pl-12 pr-4 py-4 bg-slate-100/30 border border-slate-100 text-slate-400 rounded-2xl outline-none transition-all font-medium cursor-not-allowed opacity-60"
                                        />
                                    </div>
                                </div>

                                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                                    {/* Password Field (READ ONLY Placeholder) */}
                                    <div className="space-y-2">
                                        <div className="flex justify-between px-1">
                                            <label className="text-xs font-black uppercase tracking-widest text-slate-400">Password</label>
                                            <span className="text-[10px] font-bold text-slate-400 flex items-center gap-1 uppercase tracking-tighter italic">🔒 Read Only</span>
                                        </div>
                                        <div className="relative">
                                            <LogOut className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-300 opacity-50" size={18} />
                                            <input 
                                                type="password" 
                                                value="••••••••••••"
                                                disabled
                                                className="w-full pl-12 pr-4 py-4 bg-slate-100/30 border border-slate-100 text-slate-400 rounded-2xl outline-none transition-all font-medium cursor-not-allowed opacity-60"
                                            />
                                        </div>
                                    </div>
                                </div>


                            </form>
                        </motion.div>
                    </div>
                </div>
            </main>

            <footer className="py-12 bg-navy text-white text-center px-4 mt-auto">
                <p className="font-medium leading-relaxed opacity-80">
                    <span className="block md:inline">&copy; {new Date().getFullYear()} <span className="font-bold text-white">Shreyansh Srivastava</span></span>
                    <span className="hidden md:inline"> . </span>
                    <span className="block md:inline uppercase tracking-wider text-[10px] md:text-sm md:normal-case font-bold md:font-medium">For Algorithmist Academy</span>
                </p>
            </footer>

            {/* OTP Modal */}
            <AnimatePresence>
                {modal.isOpen && (
                    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
                        <motion.div 
                            initial={{ opacity: 0 }} 
                            animate={{ opacity: 1 }} 
                            exit={{ opacity: 0 }} 
                            className="absolute inset-0 bg-navy/40 backdrop-blur-sm"
                            onClick={modal.loading || modal.step === 3 ? null : resetModal}
                        />
                        <motion.div
                            initial={{ opacity: 0, scale: 0.95, y: 20 }}
                            animate={{ opacity: 1, scale: 1, y: 0 }}
                            exit={{ opacity: 0, scale: 0.95, y: 20 }}
                            className="relative w-full max-w-md bg-white rounded-[2rem] shadow-2xl p-8 overflow-hidden"
                        >
                            {modal.step === 0 && (
                                <div className="text-center py-6">
                                    <div className="w-16 h-16 border-4 border-slate-100 border-t-lime rounded-full animate-spin mx-auto mb-4"></div>
                                    <h3 className="text-xl font-bold text-navy mb-2">Sending Security Code</h3>
                                    <p className="text-slate-500 text-sm">Sending a 6-digit OTP to {userData.email}</p>
                                </div>
                            )}

                            {modal.step === 1 && (
                                <div>
                                    <div className="flex items-center justify-between mb-6">
                                        <h3 className="text-xl font-extrabold text-navy">Security Verification</h3>
                                        <button onClick={resetModal} className="p-2 bg-slate-50 text-slate-400 hover:text-navy rounded-full transition-colors"><X size={16}/></button>
                                    </div>
                                    <p className="text-sm text-slate-500 mb-6 bg-slate-50 p-4 rounded-xl border border-slate-100">
                                        We sent a 6-digit code to <strong className="text-navy">{userData.email}</strong>. Enter it below to proceed.
                                    </p>
                                    
                                    <input 
                                        type="text" 
                                        maxLength={6}
                                        value={modal.otp}
                                        onChange={(e) => setModal({...modal, otp: e.target.value.replace(/\D/g, '')})}
                                        className="w-full text-center text-3xl tracking-[0.5em] font-black py-4 bg-slate-50 border-2 border-transparent focus:border-lime focus:bg-white rounded-2xl outline-none transition-all mb-4 text-navy placeholder:text-slate-300"
                                        placeholder="••••••"
                                    />
                                    
                                    {modal.error && <p className="text-red-500 flex items-center gap-1 text-xs font-bold mb-4 bg-red-50 p-3 rounded-lg"><AlertCircle size={14}/> {modal.error}</p>}
                                    
                                    <button 
                                        onClick={handleVerifyOtp}
                                        disabled={modal.otp.length !== 6 || modal.loading}
                                        className="w-full py-4 bg-navy text-white font-bold rounded-xl shadow-lg shadow-navy/20 hover:scale-[1.02] transition-all disabled:opacity-50 disabled:hover:scale-100 flex justify-center items-center h-14"
                                    >
                                        {modal.loading ? <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin"></div> : "Verify Code"}
                                    </button>
                                </div>
                            )}

                            {modal.step === 2 && (
                                <div>
                                    <div className="flex items-center justify-between mb-6">
                                        <h3 className="text-xl font-extrabold text-navy">Change {modal.type === 'email' ? 'Email ID' : 'Password'}</h3>
                                        <button onClick={resetModal} className="p-2 bg-slate-50 text-slate-400 hover:text-navy rounded-full transition-colors"><X size={16}/></button>
                                    </div>

                                    <div className="space-y-4 mb-6">
                                        <div className="relative">
                                            {modal.type === 'email' ? <Mail className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" size={18} /> : <Lock className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" size={18} />}
                                            <input 
                                                type={modal.type === 'email' ? 'email' : 'password'}
                                                value={modal.newValue}
                                                onChange={(e) => setModal({...modal, newValue: e.target.value})}
                                                className={`w-full pl-12 pr-4 py-4 bg-slate-50 border-2 rounded-2xl outline-none transition-all font-bold ${
                                                    modal.type === 'password' && modal.newValue
                                                        ? isPassValid ? 'border-green-100 focus:border-green-400' : 'border-red-50 focus:border-red-200'
                                                        : 'border-transparent focus:border-lime focus:bg-white'
                                                }`}
                                                placeholder={modal.type === 'email' ? 'New Email Address' : 'New Password'}
                                            />
                                        </div>

                                        {modal.type === 'password' && (
                                            <div className="grid grid-cols-2 gap-2 px-1">
                                                <div className={`flex items-center gap-1.5 text-[10px] font-bold ${changePasswordRules.length ? 'text-green-600' : 'text-slate-400'}`}>
                                                    <CheckCircle2 size={10} className={changePasswordRules.length ? 'text-green-600' : 'text-slate-300'} />
                                                    8-25 characters
                                                </div>
                                                <div className={`flex items-center gap-1.5 text-[10px] font-bold ${changePasswordRules.hasLetter ? 'text-green-600' : 'text-slate-400'}`}>
                                                    <CheckCircle2 size={10} className={changePasswordRules.hasLetter ? 'text-green-600' : 'text-slate-300'} />
                                                    One letter
                                                </div>
                                                <div className={`flex items-center gap-1.5 text-[10px] font-bold ${changePasswordRules.hasNumber ? 'text-green-600' : 'text-slate-400'}`}>
                                                    <CheckCircle2 size={10} className={changePasswordRules.hasNumber ? 'text-green-600' : 'text-slate-300'} />
                                                    One number
                                                </div>
                                                <div className={`flex items-center gap-1.5 text-[10px] font-bold ${changePasswordRules.match ? 'text-green-600' : 'text-slate-400'}`}>
                                                    <CheckCircle2 size={10} className={changePasswordRules.match ? 'text-green-600' : 'text-slate-300'} />
                                                    Passwords match
                                                </div>
                                            </div>
                                        )}

                                        <div className="relative">
                                            {modal.type === 'email' ? <Mail className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 opacity-50" size={18} /> : <Lock className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 opacity-50" size={18} />}
                                            <input 
                                                type={modal.type === 'email' ? 'email' : 'password'}
                                                value={modal.confirmValue}
                                                onChange={(e) => setModal({...modal, confirmValue: e.target.value})}
                                                className={`w-full pl-12 pr-4 py-4 bg-slate-50 border-2 rounded-2xl outline-none transition-all font-bold ${
                                                    modal.type === 'password' && modal.confirmValue 
                                                        ? changePasswordRules.match ? 'border-green-100 focus:border-green-400' : 'border-red-50 focus:border-red-200'
                                                        : 'border-transparent focus:border-lime focus:bg-white'
                                                }`}
                                                placeholder={modal.type === 'email' ? 'Confirm New Email' : 'Confirm Password'}
                                            />
                                        </div>
                                    </div>

                                    {modal.error && <p className="text-red-500 flex items-center gap-1 text-xs font-bold mb-4 bg-red-50 p-3 rounded-lg"><AlertCircle size={14}/> {modal.error}</p>}
                                    
                                    <button 
                                        onClick={handleSubmitChange}
                                        disabled={!modal.newValue || !modal.confirmValue || modal.loading || (modal.type === 'password' && (!isPassValid || !changePasswordRules.match))}
                                        className="w-full py-4 bg-lime text-navy font-bold rounded-xl shadow-lg shadow-lime/20 hover:scale-[1.02] transition-all disabled:opacity-50 disabled:hover:scale-100 flex justify-center items-center h-14"
                                    >
                                        {modal.loading ? <div className="w-5 h-5 border-2 border-navy/30 border-t-navy rounded-full animate-spin"></div> : "Save Changes"}
                                    </button>
                                </div>
                            )}

                            {modal.step === 3 && (
                                <div className="text-center py-6">
                                    <div className="w-16 h-16 bg-green-100 text-green-500 rounded-full flex items-center justify-center mx-auto mb-4">
                                        <CheckCircle2 size={32} />
                                    </div>
                                    <h3 className="text-xl font-bold text-navy mb-2">Success!</h3>
                                    <p className="text-slate-500 text-sm">Your {modal.type} has been updated successfully.</p>
                                </div>
                            )}
                        </motion.div>
                    </div>
                )}
            </AnimatePresence>
        </div>

    );
};

export default Profile;
