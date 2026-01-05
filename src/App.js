import React, { useState } from 'react';
import { CreditCard, CheckCircle, XCircle, Loader, Shield, Clock, Wallet } from 'lucide-react';

// Replace these with your actual values
const BACKEND_URL = process.env.REACT_APP_BACKEND_URL;
const RAZORPAY_KEY_ID = process.env.REACT_APP_RAZORPAY_KEY_ID;


function App() {
  const [currentPage, setCurrentPage] = useState('checkout');
  const [formData, setFormData] = useState({
    name: '',
    email: '',
    phone: '',
    amount: 199
  });
  const [paymentStatus, setPaymentStatus] = useState(null);
  const [loading, setLoading] = useState(false);
  const [currentOrderId, setCurrentOrderId] = useState(null);

  const handleInputChange = (e) => {
    setFormData({
      ...formData,
      [e.target.name]: e.target.value
    });
  };

  const redirectToOrderConfirm = () => {
    // small delay so state updates & UI don’t break
    setTimeout(() => {
      window.location.href = "https://www.paisaalert.in/orderconfirm";
    }, 0);
  };
  

  const loadRazorpayScript = () => {
    return new Promise((resolve) => {
      const script = document.createElement('script');
      script.src = 'https://checkout.razorpay.com/v1/checkout.js';
      script.onload = () => resolve(true);
      script.onerror = () => resolve(false);
      document.body.appendChild(script);
    });
  };

  const handlePayment = async () => {
    if (!formData.name || !formData.email || !formData.phone) {
      alert('Please fill all the fields');
      return;
    }

    setLoading(true);

    try {
      const scriptLoaded = await loadRazorpayScript();
      if (!scriptLoaded) {
        alert('Razorpay SDK failed to load. Please check your internet connection.');
        setLoading(false);
        return;
      }

      // Create order on backend - This will save to DB with 'pending' status
      const orderResponse = await fetch(`${BACKEND_URL}/api/create-order`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          amount: formData.amount,
          name: formData.name,
          email: formData.email,
          phone: formData.phone
        })
      });

      const orderData = await orderResponse.json();

      if (!orderData.success) {
        alert('Failed to create order. Please try again.');
        setLoading(false);
        return;
      }

      const { orderId, amount, currency } = orderData;
      setCurrentOrderId(orderId);

      console.log('✅ Order created and saved to DB with pending status:', orderId);

      const options = {
        key: RAZORPAY_KEY_ID,
        amount: amount,
        currency: currency,
        name: 'Smart Business Bookkeeping Sheet',
        description: 'Product Purchase',
        order_id: orderId,
        handler: async function (response) {
          console.log('✅ Payment handler called!', response);
          setLoading(true);
          
          try {
            console.log('Sending verification request to update DB status to success...');
            const verifyResponse = await fetch(`${BACKEND_URL}/api/verify-payment`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                razorpay_order_id: response.razorpay_order_id,
                razorpay_payment_id: response.razorpay_payment_id,
                razorpay_signature: response.razorpay_signature
              })
            });

            const verifyData = await verifyResponse.json();
            console.log('Verification response:', verifyData);

            if (verifyData.success) {
              console.log('✅ Payment verified and DB updated to success status!');
              setPaymentStatus('success');
              
              redirectToOrderConfirm();            
            } else {
              console.error('❌ Payment verification failed:', verifyData.message);
              setPaymentStatus('failed');
              alert(`Payment verification failed: ${verifyData.message || 'Unknown error'}`);
            }
          } catch (error) {
            console.error('❌ Payment verification error:', error);
            setPaymentStatus('failed');
            alert(`Payment verification failed: ${error.message || 'Please contact support'}`);
          } finally {
            setLoading(false);
          }
        },
        prefill: {
          name: formData.name,
          email: formData.email,
          contact: formData.phone
        },
        theme: {
          color: '#4C5FD5'
        },
        modal: {
          ondismiss: async function() {
            console.log('⚠️ Payment modal dismissed - updating DB to failed status');
            try {
              await fetch(`${BACKEND_URL}/api/payment-failed`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  orderId: orderId,
                  error: {
                    code: 'PAYMENT_CANCELLED',
                    description: 'Payment cancelled by user'
                  }
                })
              });
              console.log('✅ DB updated to failed status');
            } catch (error) {
              console.error('Error updating DB for cancellation:', error);
            }
            setPaymentStatus('failed');
            setLoading(false);
          }
        }
      };

      const paymentObject = new window.Razorpay(options);

      // Polling mechanism for QR payments
      let pollInterval = null;
      let pollCount = 0;
      const maxPolls = 60;

      const checkPaymentStatus = async () => {
        try {
          const statusResponse = await fetch(`${BACKEND_URL}/api/payments?orderId=${orderId}`);
          const statusData = await statusResponse.json();
          
          if (statusData.success && statusData.payment) {
            const payment = statusData.payment;
            console.log('📊 Payment status from DB:', payment.status);
            
            if (payment.status === 'success') {
              console.log('✅ Payment successful (detected via polling)');
              if (pollInterval) clearInterval(pollInterval);
              setPaymentStatus('success');
              setLoading(false);
              redirectToOrderConfirm();            
            } else if (payment.status === 'failed') {
              console.log('❌ Payment failed (detected via polling)');
              if (pollInterval) clearInterval(pollInterval);
              setPaymentStatus('failed');
              setLoading(false);
            }
          }
        } catch (error) {
          console.error('Error checking payment status from DB:', error);
        }
        
        pollCount++;
        if (pollCount >= maxPolls) {
          console.log('⏱️ Polling timeout reached');
          if (pollInterval) clearInterval(pollInterval);
          setLoading(false);
        }
      };

      paymentObject.on('payment.failed', async function (response) {
        console.log('❌ Payment failed event - updating DB to failed status');
        if (pollInterval) clearInterval(pollInterval);
        try {
          await fetch(`${BACKEND_URL}/api/payment-failed`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              orderId: orderId,
              error: {
                code: response.error.code,
                description: response.error.description
              }
            })
          });
          console.log('✅ DB updated to failed status');
        } catch (error) {
          console.error('Error updating DB for payment failure:', error);
        }
        setPaymentStatus('failed');
        setLoading(false);
      });

      paymentObject.on('ready', function() {
        console.log('🚀 Razorpay modal ready, starting DB status polling...');
        pollInterval = setInterval(checkPaymentStatus, 5000);
      });

      paymentObject.open();
      setLoading(false);

    } catch (error) {
      console.error('Payment error:', error);
      alert('Failed to initiate payment. Please try again.');
      setLoading(false);
    }
  };

  if (currentPage === 'checkout' && !paymentStatus) {
    return (
      <div style={{ 
        minHeight: '100vh', 
        background: '#F5F5F5',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'
      }}>
        {/* Header */}
        <div style={{
          background: 'linear-gradient(135deg, #4C5FD5 0%, #5B6FE8 100%)',
          padding: '60px 20px',
          textAlign: 'center',
          color: 'white'
        }}>
          <h1 style={{
            fontSize: '32px',
            fontWeight: '600',
            margin: '0 0 10px 0',
            lineHeight: '1.3'
          }}>
            Congrats! You are just one step away from Smart<br />Business Bookkeeping Sheet
          </h1>
          <p style={{
            fontSize: '14px',
            margin: '20px 0',
            opacity: '0.95'
          }}>
            36,856 sales | Excellent 4.9 of 5 | Recently Updated
          </p>
          <div style={{
            display: 'flex',
            justifyContent: 'center',
            gap: '20px',
            marginTop: '25px',
            flexWrap: 'wrap'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '14px' }}>
              <Shield size={18} />
              <span>Secured Checkout</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '14px' }}>
              <Clock size={18} />
              <span>24/7 Support Available</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '14px' }}>
              <Wallet size={18} />
              <span>Live Demo After Payment</span>
            </div>
          </div>
        </div>

        {/* Main Content */}
        <div style={{
          maxWidth: '800px',
          margin: '-30px auto 40px',
          padding: '0 20px'
        }}>
          <div style={{
            background: 'white',
            borderRadius: '8px',
            padding: '40px',
            boxShadow: '0 2px 8px rgba(0,0,0,0.1)'
          }}>
            <h2 style={{
              fontSize: '20px',
              fontWeight: '600',
              margin: '0 0 30px 0',
              color: '#333'
            }}>
              Billing details
            </h2>

            <div style={{ marginBottom: '30px' }}>
              <div style={{ marginBottom: '20px' }}>
                <input
                  type="text"
                  name="name"
                  value={formData.name}
                  onChange={handleInputChange}
                  placeholder="Name *"
                  style={{
                    width: '100%',
                    padding: '14px 16px',
                    border: '1px solid #D1D5DB',
                    borderRadius: '4px',
                    fontSize: '15px',
                    boxSizing: 'border-box',
                    outline: 'none',
                    transition: 'border-color 0.2s'
                  }}
                  onFocus={(e) => e.target.style.borderColor = '#4C5FD5'}
                  onBlur={(e) => e.target.style.borderColor = '#D1D5DB'}
                />
              </div>

              <div style={{ marginBottom: '20px' }}>
                <input
                  type="tel"
                  name="phone"
                  value={formData.phone}
                  onChange={handleInputChange}
                  placeholder="Phone *"
                  style={{
                    width: '100%',
                    padding: '14px 16px',
                    border: '1px solid #D1D5DB',
                    borderRadius: '4px',
                    fontSize: '15px',
                    boxSizing: 'border-box',
                    outline: 'none',
                    transition: 'border-color 0.2s'
                  }}
                  onFocus={(e) => e.target.style.borderColor = '#4C5FD5'}
                  onBlur={(e) => e.target.style.borderColor = '#D1D5DB'}
                />
              </div>

              <div>
                <input
                  type="email"
                  name="email"
                  value={formData.email}
                  onChange={handleInputChange}
                  placeholder="Email address *"
                  style={{
                    width: '100%',
                    padding: '14px 16px',
                    border: '1px solid #D1D5DB',
                    borderRadius: '4px',
                    fontSize: '15px',
                    boxSizing: 'border-box',
                    outline: 'none',
                    transition: 'border-color 0.2s'
                  }}
                  onFocus={(e) => e.target.style.borderColor = '#4C5FD5'}
                  onBlur={(e) => e.target.style.borderColor = '#D1D5DB'}
                />
              </div>
            </div>

            <h2 style={{
              fontSize: '20px',
              fontWeight: '600',
              margin: '40px 0 20px 0',
              color: '#333'
            }}>
              Your order
            </h2>

            <div style={{
              display: 'flex',
              justifyContent: 'space-between',
              padding: '15px 0',
              borderBottom: '1px solid #E5E7EB',
              fontWeight: '600',
              fontSize: '15px',
              color: '#333'
            }}>
              <span>Product</span>
              <span>Subtotal</span>
            </div>

            <div style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '20px 0',
              borderBottom: '1px solid #E5E7EB'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '15px' }}>
                <span style={{ fontSize: '15px', color: '#6B7280' }}>
                  Smart Business Bookkeeping Sheet
                </span>
              </div>
              <span style={{ fontSize: '15px', color: '#333', fontWeight: '500' }}>
                199.00
              </span>
            </div>



            <div style={{
              display: 'flex',
              justifyContent: 'space-between',
              padding: '20px 0',
              fontSize: '16px',
              fontWeight: '600',
              color: '#333'
            }}>
              <span>Total</span>
              <span>₹199</span>
            </div>

            <button
              onClick={handlePayment}
              disabled={loading}
              style={{
                width: '100%',
                padding: '16px',
                background: 'linear-gradient(135deg, #4C5FD5 0%, #5B6FE8 100%)',
                color: 'white',
                border: 'none',
                borderRadius: '6px',
                fontSize: '16px',
                fontWeight: '600',
                cursor: loading ? 'not-allowed' : 'pointer',
                opacity: loading ? 0.7 : 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '10px',
                transition: 'all 0.2s',
                marginTop: '20px'
              }}
              onMouseEnter={(e) => {
                if (!loading) e.target.style.transform = 'translateY(-2px)';
              }}
              onMouseLeave={(e) => {
                e.target.style.transform = 'translateY(0)';
              }}
            >
              {loading ? (
                <>
                  <Loader size={20} style={{ animation: 'spin 1s linear infinite' }} />
                  Processing...
                </>
              ) : (
                <>
                  <CreditCard size={20} />
                  Pay Now
                </>
              )}
            </button>
          </div>
        </div>

        <style>{`
          @keyframes spin {
            from { transform: rotate(0deg); }
            to { transform: rotate(360deg); }
          }
          
          @media (max-width: 768px) {
            h1 {
              font-size: 24px !important;
            }
          }
        `}</style>
      </div>
    );
  }

  if (paymentStatus) {
    return (
      <div style={{ 
        minHeight: '100vh', 
        background: '#F5F5F5',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '20px'
      }}>
        <div style={{
          maxWidth: '500px',
          width: '100%',
          background: 'white',
          borderRadius: '12px',
          padding: '50px 40px',
          boxShadow: '0 4px 20px rgba(0,0,0,0.1)',
          textAlign: 'center'
        }}>
          {paymentStatus === 'success' ? (
            <>
              <div style={{
                width: '80px',
                height: '80px',
                background: '#DEF7EC',
                borderRadius: '50%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                margin: '0 auto 25px'
              }}>
                <CheckCircle size={45} style={{ color: '#0E9F6E' }} />
              </div>
              <h2 style={{
                fontSize: '28px',
                fontWeight: '600',
                margin: '0 0 15px 0',
                color: '#333'
              }}>
                Payment Successful!
              </h2>
              <p style={{
                fontSize: '15px',
                color: '#6B7280',
                margin: '0 0 25px 0',
                lineHeight: '1.6'
              }}>
                Thank you for your purchase. The CSV file has been sent to your email address, it will be arriving 1-2 mins.
              </p>
              <div style={{
                background: '#F9FAFB',
                border: '1px solid #E5E7EB',
                borderRadius: '8px',
                padding: '20px',
                marginBottom: '30px',
                textAlign: 'left'
              }}>
                <p style={{
                  fontSize: '13px',
                  color: '#6B7280',
                  margin: '0 0 5px 0'
                }}>
                  Email sent to:
                </p>
                <p style={{
                  fontSize: '15px',
                  fontWeight: '600',
                  color: '#333',
                  margin: 0
                }}>
                  {formData.email}
                </p>
              </div>
            </>
          ) : (
            <>
              <div style={{
                width: '80px',
                height: '80px',
                background: '#FEE2E2',
                borderRadius: '50%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                margin: '0 auto 25px'
              }}>
                <XCircle size={45} style={{ color: '#DC2626' }} />
              </div>
              <h2 style={{
                fontSize: '28px',
                fontWeight: '600',
                margin: '0 0 15px 0',
                color: '#333'
              }}>
                Payment Failed
              </h2>
              <p style={{
                fontSize: '15px',
                color: '#6B7280',
                margin: '0 0 30px 0',
                lineHeight: '1.6'
              }}>
                Your payment could not be processed. Please try again.
              </p>
            </>
          )}

          <button
            onClick={() => {
              setCurrentPage('checkout');
              setPaymentStatus(null);
              setCurrentOrderId(null);
              setFormData({
                name: '',
                email: '',
                phone: '',
                amount: 199
              });
            }}
            style={{
              width: '100%',
              padding: '14px',
              background: 'linear-gradient(135deg, #4C5FD5 0%, #5B6FE8 100%)',
              color: 'white',
              border: 'none',
              borderRadius: '6px',
              fontSize: '16px',
              fontWeight: '600',
              cursor: 'pointer',
              transition: 'all 0.2s'
            }}
            onMouseEnter={(e) => e.target.style.transform = 'translateY(-2px)'}
            onMouseLeave={(e) => e.target.style.transform = 'translateY(0)'}
          >
            Back to Home
          </button>
        </div>
      </div>
    );
  }
}

export default App;